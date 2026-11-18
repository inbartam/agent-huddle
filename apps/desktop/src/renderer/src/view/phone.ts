/**
 * Settings → Phone access (M6, F26) and the "phone connected" mark: words and the pure decisions behind them. The
 * state comes from `HuddleState.phone` (reduced from `phone.*` events) and `HuddleState.settings.phone` (the last
 * address and port chosen); the pairing code comes only from the `phone.pair` command result and is never stored.
 */
import {
  PHONE_DEFAULT_PORT,
  PHONE_IDLE_OFF_MS,
  PHONE_PORT_MAX,
  PHONE_PORT_MIN,
  type ControlState,
  type HuddleCommand,
  type HuddleState,
  type PhoneAccessReason,
  type PhoneAddress,
  type PhoneDeviceState,
  type PhonePairing,
  type PhoneState,
} from '@huddle/shared';
import { clockTime, plural, UNKNOWN } from './format.js';
import { shortDate } from './remember-settings.js';

const IDLE_HOURS = Math.round(PHONE_IDLE_OFF_MS / 3_600_000);

export const PHONE_SETTINGS_WORDS = {
  section: 'Phone access',
  note: 'Off by default',
  what: 'Open a small page on your phone to see your agents and allow or deny their approval requests. The phone cannot message, answer questions, pause, stop or launch agents.',
  risk: `It is plain HTTP on your home network: use it only on a network you trust. It turns itself off after ${String(IDLE_HOURS)} hours unused.`,
  addressLabel: 'Address',
  portLabel: 'Port',
  looking: 'Looking for network addresses…',
  noAddress:
    'No private network address found. Connect this computer to Wi-Fi or Ethernet (a home network, not a VPN), then look again.',
  lookAgain: 'Look again',
  turnOn: 'Turn on',
  turningOn: 'Turning on…',
  turnOff: 'Turn off',
  pickAddress: 'Pick an address first.',
  isOn: 'On',
  isOff: 'Off',
  urlLead: 'On your phone, open',
  urlHelp: 'Type it into the browser on a phone on the same network.',
  pair: 'Pair a phone',
  pairOffReason: 'Turn phone access on first.',
  codeLead: 'Type this code on the phone',
  codeExpired: 'The code ran out. Press "Pair a phone" for a new one.',
  devicesTitle: 'Paired phones',
  noDevices: 'No phone is paired yet.',
  revoke: 'Revoke',
  revokeAll: 'Revoke all',
  revokeAllBack: 'Back',
  connected: 'connected',
  notConnected: 'not connected',
} as const;

/** Why phone access is off, in words; null when there is nothing to explain (never on, or the user turned it off). */
export function offReasonWords(reason: PhoneAccessReason | null): string | null {
  switch (reason) {
    case 'idle':
      return `Phone access turned itself off after ${String(IDLE_HOURS)} hours without a phone using it.`;
    case 'address_gone':
      return 'Phone access turned off: its address is no longer on this computer (the network changed). Pick an address and turn it on again.';
    case 'failed':
      return 'Phone access stopped: it could not keep listening. Turn it on again, or pick another port.';
    case 'shutdown':
      return 'Phone access turned off when Huddle quit. It always starts off.';
    case 'user':
    case null:
      return null;
  }
}

/** "Wi-Fi · 192.168.1.20". */
export function addressLabel(a: PhoneAddress): string {
  return `${a.interfaceName.trim() === '' ? UNKNOWN : a.interfaceName} · ${a.ip}`;
}

/** The address to preselect: the last one chosen when it is still there, else the first. */
export function preferredAddress(addresses: readonly PhoneAddress[], lastIp: string | null): string | null {
  if (lastIp !== null && addresses.some((a) => a.ip === lastIp)) return lastIp;
  return addresses[0]?.ip ?? null;
}

/** The port typed, or why it is not one. */
export function parsePort(raw: string): { port: number } | { error: string } {
  const t = raw.trim();
  const n = /^[0-9]+$/.test(t) ? Number(t) : Number.NaN;
  if (!Number.isInteger(n) || n < PHONE_PORT_MIN || n > PHONE_PORT_MAX) {
    return { error: `Pick a port from ${String(PHONE_PORT_MIN)} to ${String(PHONE_PORT_MAX)}.` };
  }
  return { port: n };
}

export function enableCommand(ip: string, port: number): HuddleCommand {
  return { type: 'phone.enable', ip, port };
}
export const DISABLE_COMMAND: HuddleCommand = { type: 'phone.disable' };
export const PAIR_COMMAND: HuddleCommand = { type: 'phone.pair' };
/** `deviceId` from HuddleState.phone.devices, or 'all'. */
export function revokeCommand(deviceId: string): HuddleCommand {
  return { type: 'phone.revoke', deviceId };
}

/** The phone state, or "off, nothing paired" when the core has not announced phone access. */
export function currentPhone(state: HuddleState): PhoneState {
  return state.phone ?? { enabled: false, url: null, changedAt: 0, reason: null, devices: [] };
}

/** The last port chosen (Settings' starting value). */
export function lastPort(state: HuddleState): number {
  return state.settings?.phone?.port ?? PHONE_DEFAULT_PORT;
}
export function lastIp(state: HuddleState): string | null {
  return state.settings?.phone?.ip ?? null;
}

export function turnOnControl(ip: string | null, busy: boolean): ControlState {
  if (ip === null) return { enabled: false, reason: PHONE_SETTINGS_WORDS.pickAddress };
  return { enabled: !busy, reason: busy ? PHONE_SETTINGS_WORDS.turningOn : null };
}

export function pairControl(phone: PhoneState): ControlState {
  return phone.enabled
    ? { enabled: true, reason: null }
    : { enabled: false, reason: PHONE_SETTINGS_WORDS.pairOffReason };
}

/** "123 456": easier to read across a room and to type. */
export function codeWords(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** "1:42 left"; null once the code ran out. */
export function countdownWords(expiresAt: number, now: number): string | null {
  const left = expiresAt - now;
  if (left <= 0) return null;
  const s = Math.ceil(left / 1000);
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')} left`;
}

/** A code on screen, and the phones paired when it was issued (a new one among the devices means it was used). */
export interface ShownPairing extends PhonePairing {
  knownDeviceIds: readonly string[];
}

/**
 * What happens to the code on screen now: it stays, it ran out, or a phone just paired with it (the new device's name
 * is returned). Also gone when phone access is off. Pure.
 */
export function pairingOutcome(
  shown: ShownPairing,
  phone: PhoneState,
  now: number,
): { kind: 'shown' } | { kind: 'expired' } | { kind: 'paired'; name: string } | { kind: 'off' } {
  if (!phone.enabled) return { kind: 'off' };
  const known = new Set(shown.knownDeviceIds);
  const fresh = phone.devices.find((d) => !known.has(d.deviceId));
  if (fresh !== undefined) return { kind: 'paired', name: fresh.name };
  if (shown.expiresAt <= now) return { kind: 'expired' };
  return { kind: 'shown' };
}

export function pairedWords(name: string): string {
  return `Paired: ${name}.`;
}

export interface DeviceRow {
  deviceId: string;
  /** From the phone: render as text. */
  name: string;
  paired: string;
  lastSeen: string;
  connected: boolean;
  connectedWord: string;
  glyph: string;
}

function when(ts: number, now: number): string {
  return `${shortDate(ts, now)} ${clockTime(ts)}`;
}

export function deviceRow(d: PhoneDeviceState, now: number): DeviceRow {
  return {
    deviceId: d.deviceId,
    name: d.name.trim() === '' ? UNKNOWN : d.name,
    paired: d.pairedAt === null ? `paired ${UNKNOWN}` : `paired ${when(d.pairedAt, now)}`,
    lastSeen: d.lastSeenAt === null ? `last seen ${UNKNOWN}` : `last seen ${when(d.lastSeenAt, now)}`,
    connected: d.connected,
    connectedWord: d.connected ? PHONE_SETTINGS_WORDS.connected : PHONE_SETTINGS_WORDS.notConnected,
    glyph: d.connected ? '●' : '○',
  };
}

export function revokeAllQuestion(n: number): string {
  return `Revoke ${n === 1 ? 'the paired phone' : `all ${String(n)} paired phones`}? Each must pair again with a new code to see your agents.`;
}

/**
 * The title bar's phone mark: a filled phone shape when a phone is connected now, an outline while access is on with
 * none connected, nothing while off. Shape and words, colour only adds.
 */
export function phoneMark(
  state: HuddleState | null,
): { glyph: string; text: string; tone: 'working' | 'idle'; title: string } | null {
  const phone = state?.phone;
  if (phone?.enabled !== true) return null;
  const connected = phone.devices.filter((d) => d.connected).length;
  if (connected > 0) {
    return {
      glyph: '▮',
      text: connected === 1 ? 'phone connected' : `${String(connected)} phones connected`,
      tone: 'working',
      title: `Phone access is on: ${plural(connected, 'phone')} connected now. Settings, Phone access to revoke.`,
    };
  }
  return {
    glyph: '▯',
    text: 'phone access on',
    tone: 'idle',
    title: 'Phone access is on; no phone is connected right now.',
  };
}
