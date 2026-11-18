/**
 * PhoneHost (M6, F26): phone access as HuddleCore runs it. Owns the listener (PhoneServer), the pairing code, the
 * paired phones (phone-devices.json) and the auto-off timer, and writes what happens as `phone.access_changed` and
 * `phone.device_changed` events through the core's `accept` (the only state change is the reducer's).
 *
 * Rules it keeps:
 *  - Off by default, and off at every start: phone access is turned on only by `phone.enable` (owner decision). The
 *    chosen address must be a private LAN IPv4 this computer has now (`addressProblem`); never 0.0.0.0, loopback or a
 *    public address. Tests replace the check (`addressCheck`) to bind 127.0.0.1; the production check is unit tested.
 *  - Auto-off: after `idleOffMs` (PHONE_IDLE_OFF_MS, 8 h) without a phone action (pairing, a fresh page open
 *    `GET /api/state?open=1`, and every action the core carried out: Allow, Deny and the ADR-030 actions; stream
 *    reconnects do not count, owner 2026-11-16), or when the address is no longer on any adapter, the listener closes and `phone.access_changed {enabled:false, reason}` is written.
 *  - Revoke takes effect at once: the device leaves the in-memory list the server authenticates against before
 *    anything is awaited, its id joins `revokedIds` (checked on every request for the life of the process), and its
 *    live streams are closed. The file write follows on the queue.
 *  - Mutations (enable, disable, revoke, pairing completion, retention) run one at a time on a queue, but revoke
 *    changes the list before it queues. So no queued job may replace the list with a copy it took before an await:
 *    pairing appends its phone to the list as it is after the file write, never to a snapshot, and every file write
 *    writes the list as it is when the write starts, without revoked ids. A revoke that lands while a pairing write is
 *    in flight therefore stays in force in memory, and the file is rewritten without it before the pairing answers.
 *  - Tokens are never stored or logged; only their sha-256 is kept (devices.ts). The pairing code lives in memory only.
 *
 * Side effects (network, files, timers) live here; the clock, ids and the event sink are injected.
 */
import os from 'node:os';
import {
  PHONE_DEFAULT_PORT,
  PHONE_IDLE_OFF_MS,
  PHONE_MAX_DEVICES,
  PHONE_PORT_MAX,
  PHONE_PORT_MIN,
  type CommandResult,
  type EventOfType,
  type HuddleEvent,
  type PhoneAccessReason,
  type PhoneAddress,
  type PhoneDeviceChange,
  type PhoneAction,
  type PhoneRevokeReason,
  type PhoneView,
} from '@huddle/shared';
import { PHONE_SESSION_ID } from '../state/huddle-sessions.js';
import { addressProblem, lanAddresses, type NetworkInterfaces } from './address.js';
import {
  cleanDeviceName,
  deviceForToken,
  hashToken,
  newDeviceId,
  newDeviceToken,
  readPhoneDevices,
  removePhoneDevicesFile,
  writePhoneDevices,
  type StoredPhoneDevice,
} from './devices.js';
import { PairingCodes } from './pairing.js';
import {
  PhoneServer,
  PhoneServerError,
  type ActOutcome,
  type DecideOutcome,
  type PairOutcome,
} from './phone-server.js';

/** How often the auto-off check runs while phone access is on. */
export const PHONE_CHECK_EVERY_MS = 60_000;
/** lastSeenAt is written to the file at most this often per device (it changes with every request). */
const LAST_SEEN_WRITE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export const PHONE_WORDS = {
  off: 'Phone access is off. Turn it on in Settings first.',
  full: `Only ${String(PHONE_MAX_DEVICES)} phones can be paired. Revoke one first.`,
  saveFailed: 'The paired phones could not be saved. Check that the app data folder is writable, then try again.',
  badPort: `Pick a port from ${String(PHONE_PORT_MIN)} to ${String(PHONE_PORT_MAX)}.`,
  notFound: 'That phone is not paired.',
} as const;

export interface PhoneLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface PhoneHostDeps {
  dataDir: string;
  now: () => number;
  nextId: () => string;
  /** Reduce and store events (HuddleCore's accept); resolves once stored. */
  accept: (events: readonly HuddleEvent[]) => Promise<unknown>;
  logger: PhoneLogger;
  /** The phone view, masked, ready to send. */
  view: () => PhoneView;
  /** Approve or deny a held approval as the phone (HuddleCore routes it through the broker with via 'phone'). */
  decide: (requestId: string, decision: 'allow' | 'deny') => CommandResult;
  /**
   * One allowlisted action from a phone (ADR-030): answer, message, pause, resume, stop. HuddleCore checks the target
   * is in the phone view and allowed there, then runs it through the desktop's own path with `via: 'phone'`.
   */
  act?: (action: PhoneAction) => Promise<CommandResult>;
  /** Save the chosen address and port in the user's settings. */
  saveChoice: (ip: string, port: number) => Promise<void>;
  /** The phone page's folder (built from apps/desktop/src/phone to out/phone); null serves the API only. */
  staticDir?: string | null;
  /** The network adapters (default `os.networkInterfaces`). */
  interfaces?: () => NetworkInterfaces;
  /** Tests only: replaces the address rule (`addressProblem`) so a test can bind 127.0.0.1. */
  addressCheck?: (ip: string, interfaces: NetworkInterfaces) => string | null;
  idleOffMs?: number;
  checkEveryMs?: number;
  /** Passed to the server (tests shorten them). */
  server?: { heartbeatMs?: number; streamMaxMs?: number; throttleMs?: number; streamBufferBytes?: number };
  /** Pairing code options (tests inject the random source). */
  randomInt?: (max: number) => number;
  /** Tests only: replaces the phone-devices.json writer (default `writePhoneDevices`) so a test can hold a write. */
  writeDevices?: (dataDir: string, devices: readonly StoredPhoneDevice[]) => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PhoneHost {
  private readonly deps: PhoneHostDeps;
  private readonly codes: PairingCodes;
  private devices: StoredPhoneDevice[] = [];
  /** Every device revoked in this process. Device ids are random and never reused, so the set is never cleared. */
  private readonly revokedIds = new Set<string>();
  private devicesBad = false;
  private server: PhoneServer | null = null;
  private bound: { ip: string; port: number; url: string } | null = null;
  private lastActivity = 0;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lastWritten = new Map<string, number>();
  private stopped = false;

  constructor(deps: PhoneHostDeps) {
    this.deps = deps;
    this.codes = new PairingCodes({
      now: deps.now,
      ...(deps.randomInt !== undefined ? { randomInt: deps.randomInt } : {}),
    });
  }

  /** The phone URL while on, else null. */
  url(): string | null {
    return this.bound?.url ?? null;
  }

  /** The address the listener is bound to while on (tests). */
  address(): { ip: string; port: number } | null {
    return this.bound === null ? null : { ip: this.bound.ip, port: this.bound.port };
  }

  /** Paired device ids (tests, diagnostics). */
  deviceIds(): string[] {
    return this.devices.map((d) => d.deviceId);
  }

  /** The private LAN addresses phone access may use now (`phone.addresses`). */
  addresses(): PhoneAddress[] {
    return lanAddresses(this.interfaces());
  }

  private interfaces(): NetworkInterfaces {
    try {
      return (this.deps.interfaces ?? os.networkInterfaces)();
    } catch {
      return {};
    }
  }

  /** The paired phones that may be written to the file: the current list without anything revoked. */
  private persistable(): StoredPhoneDevice[] {
    return this.devices.filter((d) => !this.revokedIds.has(d.deviceId));
  }

  private writeDevices(devices: readonly StoredPhoneDevice[]): Promise<void> {
    return (this.deps.writeDevices ?? writePhoneDevices)(this.deps.dataDir, devices);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private accessEvent(source: 'user' | 'huddle', enabled: boolean, url: string | null, reason: PhoneAccessReason) {
    const event: EventOfType<'phone.access_changed'> = {
      id: this.deps.nextId(),
      type: 'phone.access_changed',
      ts: this.deps.now(),
      sessionId: PHONE_SESSION_ID,
      agentKey: PHONE_SESSION_ID,
      source,
      enabled,
      url,
      reason,
    };
    return event;
  }

  private deviceEvent(
    device: StoredPhoneDevice,
    change: PhoneDeviceChange,
    source: 'user' | 'huddle',
    reason?: PhoneRevokeReason,
  ): HuddleEvent {
    const event: EventOfType<'phone.device_changed'> = {
      id: this.deps.nextId(),
      type: 'phone.device_changed',
      ts: this.deps.now(),
      sessionId: PHONE_SESSION_ID,
      agentKey: PHONE_SESSION_ID,
      source,
      deviceId: device.deviceId,
      name: device.name,
      change,
      ...(change === 'paired' || change === 'known' ? { pairedAt: device.createdAt } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    return event;
  }

  /** At start: read the paired phones and announce them (`known`). Phone access stays off. */
  async start(): Promise<void> {
    const read = await readPhoneDevices(this.deps.dataDir);
    this.devices = read.devices;
    this.devicesBad = read.bad;
    if (read.bad) this.deps.logger.warn('phone-devices.json could not be read; no phone is paired');
    if (this.devices.length > 0) {
      await this.deps.accept(this.devices.map((d) => this.deviceEvent(d, 'known', 'huddle')));
    }
  }

  // --- commands ------------------------------------------------------------------------------------------------------

  enable(ip: string, port: number = PHONE_DEFAULT_PORT): Promise<CommandResult> {
    return this.enqueue(() => this.runEnable(ip, port));
  }

  private async runEnable(ip: string, port: number): Promise<CommandResult> {
    if (this.stopped) return { ok: false, code: 'failed', message: 'Agent Huddle is shutting down.' };
    if (!Number.isInteger(port) || port < PHONE_PORT_MIN || port > PHONE_PORT_MAX) {
      return { ok: false, code: 'invalid', message: PHONE_WORDS.badPort };
    }
    const check = this.deps.addressCheck ?? addressProblem;
    const problem = check(ip, this.interfaces());
    if (problem !== null) return { ok: false, code: 'invalid', message: problem };
    if (this.bound !== null && this.bound.ip === ip && this.bound.port === port) {
      return { ok: true, detail: this.bound.url };
    }
    if (this.bound !== null) await this.runDisable('user', false);
    const server = new PhoneServer({
      host: ip,
      port,
      now: this.deps.now,
      staticDir: this.deps.staticDir ?? null,
      authenticate: (token) => this.authenticate(token),
      pair: (code, name) => this.pairFromPhone(code, name),
      view: () => this.deps.view(),
      decide: (deviceId, requestId, decision) => this.decideFromPhone(deviceId, requestId, decision),
      ...(this.deps.act !== undefined
        ? { act: (deviceId: string, action: PhoneAction) => this.actFromPhone(deviceId, action) }
        : {}),
      onActivity: (deviceId, action) => {
        this.noteActivity(deviceId, action);
      },
      onStreamChange: (deviceId, connected) => {
        this.onStreamChange(deviceId, connected);
      },
      ...(this.deps.server ?? {}),
    });
    let bound: { host: string; port: number };
    try {
      bound = await server.start();
    } catch (error) {
      this.deps.logger.warn('phone access could not start', {
        error: error instanceof PhoneServerError ? error.code : messageOf(error),
      });
      return {
        ok: false,
        code: 'failed',
        message: error instanceof PhoneServerError ? error.message : 'Phone access could not start listening.',
      };
    }
    const url = `http://${ip}:${String(bound.port)}/`;
    this.server = server;
    this.bound = { ip, port: bound.port, url };
    this.lastActivity = this.deps.now();
    this.startTimer();
    try {
      await this.deps.saveChoice(ip, port);
    } catch (error) {
      // Not fatal: phone access is on; only the remembered choice is lost.
      this.deps.logger.warn('could not save the phone address', { error: messageOf(error) });
    }
    await this.deps.accept([this.accessEvent('user', true, url, 'user')]);
    this.deps.logger.info('phone access on', { port: bound.port });
    return { ok: true, detail: url };
  }

  disable(reason: PhoneAccessReason = 'user'): Promise<CommandResult> {
    return this.enqueue(() => this.runDisable(reason, true));
  }

  private async runDisable(reason: PhoneAccessReason, announce: boolean): Promise<CommandResult> {
    this.codes.clear();
    this.stopTimer();
    const server = this.server;
    const wasOn = this.bound !== null;
    this.server = null;
    this.bound = null;
    if (server !== null) await server.close();
    if (wasOn && announce) {
      await this.deps.accept([this.accessEvent(reason === 'user' ? 'user' : 'huddle', false, null, reason)]);
      this.deps.logger.info('phone access off', { reason });
    }
    return { ok: true };
  }

  /** A new pairing code (shown on the desktop; never stored). */
  pair(): CommandResult {
    if (this.bound === null) return { ok: false, code: 'failed', message: PHONE_WORDS.off };
    if (this.devices.length >= PHONE_MAX_DEVICES) return { ok: false, code: 'failed', message: PHONE_WORDS.full };
    const pairing = this.codes.issue();
    return { ok: true, detail: pairing.code, phonePairing: pairing };
  }

  revoke(target: { deviceId: string } | { all: true }, reason: PhoneRevokeReason = 'user'): Promise<CommandResult> {
    // Immediate: out of the list the server authenticates against, and streams closed, before anything is awaited.
    const gone = 'all' in target ? [...this.devices] : this.devices.filter((d) => d.deviceId === target.deviceId);
    if (!('all' in target) && gone.length === 0) {
      return Promise.resolve({ ok: false, code: 'not_found', message: PHONE_WORDS.notFound });
    }
    const ids = new Set(gone.map((d) => d.deviceId));
    for (const id of ids) this.revokedIds.add(id);
    this.devices = this.devices.filter((d) => !ids.has(d.deviceId));
    for (const id of ids) {
      this.server?.closeStreams(id);
      this.lastWritten.delete(id);
    }
    return this.enqueue(async () => {
      let saved = true;
      try {
        // The list as it is now (a pairing that finished meanwhile is kept), not as it was when revoke was called.
        const keep = this.persistable();
        if (keep.length === 0 && reason === 'delete_all') await removePhoneDevicesFile(this.deps.dataDir);
        else await this.writeDevices(keep);
        this.devicesBad = false;
      } catch (error) {
        saved = false;
        this.deps.logger.error('could not save the paired phones', { error: messageOf(error) });
      }
      if (gone.length > 0) {
        await this.deps.accept(
          gone.map((d) => this.deviceEvent(d, 'revoked', reason === 'user' ? 'user' : 'huddle', reason)),
        );
      }
      // The revoke is in force in memory either way; the answer says when the file still lists the phone.
      return saved
        ? { ok: true, detail: gone.length === 1 ? '1 phone revoked.' : `${String(gone.length)} phones revoked.` }
        : { ok: false, code: 'failed', message: PHONE_WORDS.saveFailed };
    });
  }

  /** Retention (M5 rule applied to phones): phones not seen for `days` days are revoked. Returns how many. */
  async retention(days: number): Promise<number> {
    const cutoff = this.deps.now() - days * DAY_MS;
    const old = this.devices.filter((d) => (d.lastSeenAt ?? d.createdAt) < cutoff);
    for (const d of old) await this.revoke({ deviceId: d.deviceId }, 'retention');
    return old.length;
  }

  /** Delete all history: every phone is revoked and phone-devices.json removed. */
  async deleteAll(): Promise<number> {
    const n = this.devices.length;
    if (n > 0 || this.devicesBad) await this.revoke({ all: true }, 'delete_all');
    return n;
  }

  /** Quit: the listener closes (streams end) and `phone.access_changed {enabled:false, reason:'shutdown'}` is written. */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.enqueue(() => this.runDisable('shutdown', true));
  }

  /** The state changed: live streams get the new view (throttled). */
  notifyChanged(): void {
    this.server?.notifyChanged();
  }

  // --- from the server ---------------------------------------------------------------------------------------------

  private authenticate(token: string): { deviceId: string } | null {
    const device = deviceForToken(this.devices, token);
    return device === null || this.revokedIds.has(device.deviceId) ? null : { deviceId: device.deviceId };
  }

  private async pairFromPhone(code: string, rawName: string): Promise<PairOutcome> {
    if (this.devices.length >= PHONE_MAX_DEVICES) {
      return { ok: false, status: 409, error: 'no more phones can be paired', failedAuth: false };
    }
    const attempt = this.codes.attempt(code);
    if (attempt !== 'ok') {
      return {
        ok: false,
        status: attempt === 'none' ? 403 : 401,
        error: attempt === 'none' ? 'no pairing code in force' : 'wrong pairing code',
        failedAuth: true,
      };
    }
    this.lastActivity = this.deps.now();
    return this.enqueue(async (): Promise<PairOutcome> => {
      if (this.bound === null) return { ok: false, status: 403, error: 'phone access is off', failedAuth: false };
      const token = newDeviceToken();
      const device: StoredPhoneDevice = {
        deviceId: newDeviceId(),
        name: cleanDeviceName(rawName),
        tokenHash: hashToken(token),
        createdAt: this.deps.now(),
        lastSeenAt: null,
      };
      const written = [...this.persistable(), device];
      try {
        await this.writeDevices(written);
      } catch (error) {
        this.deps.logger.error('could not save a paired phone', { error: messageOf(error) });
        return { ok: false, status: 500, error: 'the phone could not be saved', failedAuth: false };
      }
      // A revoke (one phone, all, retention) may have landed during the write: it changed this.devices at once and its
      // own write is queued behind this job. Append to the list as it is now, never to `written`, so the revoke is not
      // undone; and if the file just written still lists a revoked phone, rewrite it now rather than after this job.
      this.devices = [...this.devices, device];
      this.devicesBad = false;
      if (written.some((d) => this.revokedIds.has(d.deviceId))) {
        try {
          await this.writeDevices(this.persistable());
        } catch (error) {
          // The revoke's own queued write tries again next; in memory the revoke is in force either way.
          this.deps.logger.error('could not save the paired phones', { error: messageOf(error) });
        }
      }
      await this.deps.accept([this.deviceEvent(device, 'paired', 'user')]);
      return { ok: true, deviceId: device.deviceId, token };
    });
  }

  private decideFromPhone(deviceId: string, requestId: string, decision: 'allow' | 'deny'): DecideOutcome {
    if (this.revokedIds.has(deviceId) || !this.devices.some((d) => d.deviceId === deviceId)) {
      return { ok: false, status: 404, error: 'not paired' };
    }
    const result = this.deps.decide(requestId, decision);
    if (result.ok) return { ok: true };
    switch (result.code) {
      case 'not_found':
        return { ok: false, status: 404, error: 'no such request' };
      case 'expired':
        return { ok: false, status: 409, error: 'already answered or timed out' };
      case 'invalid':
        // The core's own fixed sentence (e.g. AX-01: "Answer this one on the computer."), shown as text.
        return { ok: false, status: 400, error: result.message };
      default:
        return { ok: false, status: 503, error: 'not available' };
    }
  }

  /** An allowlisted action (ADR-030). The refusal words are the core's own (fixed sentences, shown as text). */
  private async actFromPhone(deviceId: string, action: PhoneAction): Promise<ActOutcome> {
    const act = this.deps.act;
    if (act === undefined) return { ok: false, status: 503, error: 'not available' };
    if (this.revokedIds.has(deviceId) || !this.devices.some((d) => d.deviceId === deviceId)) {
      return { ok: false, status: 404, error: 'not paired' };
    }
    const result = await act(action);
    if (result.ok) return result.detail !== undefined ? { ok: true, detail: result.detail } : { ok: true };
    switch (result.code) {
      case 'not_found':
        return { ok: false, status: 404, error: result.message };
      case 'expired':
        return { ok: false, status: 409, error: result.message };
      case 'invalid':
        return { ok: false, status: 400, error: result.message };
      case 'unsupported':
        return { ok: false, status: 403, error: result.message };
      default:
        return { ok: false, status: 503, error: result.message };
    }
  }

  /** Every request: "last seen". Only an action (fresh open, Allow, Deny, any other action the core carried out) resets the 8-hour auto-off. */
  private noteActivity(deviceId: string, action: boolean): void {
    const now = this.deps.now();
    if (action) this.lastActivity = now;
    const device = this.devices.find((d) => d.deviceId === deviceId);
    if (device === undefined) return;
    device.lastSeenAt = now;
    const written = this.lastWritten.get(deviceId) ?? 0;
    if (now - written < LAST_SEEN_WRITE_MS) return;
    this.lastWritten.set(deviceId, now);
    void this.enqueue(async () => {
      try {
        await this.writeDevices(this.persistable());
      } catch (error) {
        this.deps.logger.warn('could not save when a phone was last seen', { error: messageOf(error) });
      }
    });
  }

  private onStreamChange(deviceId: string, connected: boolean): void {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    // A revoked phone's stream closing is not news: its revoke was written already.
    if (device === undefined) return;
    void this.deps.accept([this.deviceEvent(device, connected ? 'connected' : 'disconnected', 'huddle')]);
  }

  // --- auto-off --------------------------------------------------------------------------------------------------------

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(
      () => {
        this.check();
      },
      Math.max(10, this.deps.checkEveryMs ?? PHONE_CHECK_EVERY_MS),
    );
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** The auto-off check (also run by tests). */
  check(): void {
    const bound = this.bound;
    if (bound === null || this.stopped) return;
    const idle = this.deps.now() - this.lastActivity >= (this.deps.idleOffMs ?? PHONE_IDLE_OFF_MS);
    const check = this.deps.addressCheck ?? addressProblem;
    const gone = !idle && check(bound.ip, this.interfaces()) !== null;
    if (!idle && !gone) return;
    void this.enqueue(async () => {
      // Turned off or moved meanwhile: nothing to do.
      if (this.bound !== bound) return;
      await this.runDisable(idle ? 'idle' : 'address_gone', true);
    });
  }
}
