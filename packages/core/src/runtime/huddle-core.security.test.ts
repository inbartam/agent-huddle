/**
 * Security review M1, findings 1 and 3: quit wins every race with start and attach, and consent is stored only
 * after the change it was given for is in settings.json.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookInstaller, isHuddleHook, type ApplyResult } from '../setup/install-hooks.js';
import { SqliteEventStore } from '../store/sqlite-store.js';
import { HuddleCore, type HuddleCoreDeps } from './huddle-core.js';
import { readHuddleSettings, writeHuddleSettings } from './huddle-settings.js';
import { consentRecord } from '../test/consent.js';

const TOKEN = 'test-token-0123456789';

interface Env {
  root: string;
  dataDir: string;
  claudeDir: string;
  settingsPath: string;
  forwarder: string;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function makeEnv(): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-sec-'));
  const env: Env = {
    root,
    dataDir: path.join(root, 'data'),
    claudeDir: path.join(root, 'claude'),
    settingsPath: path.join(root, 'claude', 'settings.json'),
    forwarder: path.join(root, 'forwarder.mjs'),
  };
  await fsp.mkdir(env.claudeDir, { recursive: true });
  await fsp.writeFile(env.forwarder, '// test forwarder\n');
  await fsp.writeFile(env.settingsPath, JSON.stringify({ theme: 'dark' }, null, 2));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return env;
}

function makeCore(env: Env, extra: Partial<HuddleCoreDeps> = {}): HuddleCore {
  const core = new HuddleCore({
    dataDir: env.dataDir,
    claudeConfigDir: env.claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: env.forwarder,
    newToken: () => TOKEN,
    ...extra,
  });
  cleanups.push(() => core.dispose());
  return core;
}

async function consent(env: Env): Promise<void> {
  await writeHuddleSettings(env.dataDir, consentRecord(env.claudeDir, env.settingsPath));
}

async function huddleHooksIn(file: string): Promise<number> {
  const settings = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
  const hooks = (settings.hooks ?? {}) as Record<string, { hooks?: unknown[] }[]>;
  return Object.values(hooks)
    .flatMap((groups) => groups.flatMap((g) => g.hooks ?? []))
    .filter((h) => isHuddleHook(h)).length;
}

/** A promise you resolve from outside. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Holds HookInstaller.apply for install changes until the gate opens; `entered` resolves when one is waiting. */
function slowInstallApply(): { gate: ReturnType<typeof gate>; entered: Promise<void> } {
  const g = gate();
  const entered = gate();
  // Called below with the instance as this, so leaving it unbound is intended.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = HookInstaller.prototype.apply;
  vi.spyOn(HookInstaller.prototype, 'apply').mockImplementation(async function (
    this: HookInstaller,
    ...args: Parameters<HookInstaller['apply']>
  ): Promise<ApplyResult> {
    if (args[0].mode === 'install') {
      entered.open();
      await g.promise;
    }
    return original.apply(this, args);
  });
  return { gate: g, entered: entered.promise };
}

describe('quit during start (finding 1)', () => {
  it('never starts the server or attaches when quit begins during a slow replay', async () => {
    const env = await makeEnv();
    await consent(env);
    const replay = gate();
    // Called below with the instance as this, so leaving it unbound is intended.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = SqliteEventStore.prototype.listSessionRecords;
    vi.spyOn(SqliteEventStore.prototype, 'listSessionRecords').mockImplementation(async function (
      this: SqliteEventStore,
    ) {
      await replay.promise;
      return original.call(this);
    });
    const core = makeCore(env, { disposeTimeoutMs: 200 });
    const starting = core.start();
    // Dispose gives the start 50 ms, then shuts down without it.
    await core.dispose();
    replay.open();
    const result = await starting;
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(core.stats().server).toBeNull();
    expect(core.setupStatus()).toMatchObject({ attached: false, port: null });
    expect(await huddleHooksIn(env.settingsPath)).toBe(0);
    expect(
      await fsp.access(path.join(env.claudeDir, 'agent-huddle')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it('waits for an attach in flight at start and then detaches it', async () => {
    const env = await makeEnv();
    await consent(env);
    const slow = slowInstallApply();
    const core = makeCore(env);
    const starting = core.start();
    await slow.entered;
    const disposing = core.dispose();
    setTimeout(slow.gate.open, 50);
    await disposing;
    await starting;
    expect(await huddleHooksIn(env.settingsPath)).toBe(0);
  }, 20_000);

  it('detaches an attach that lands after dispose stopped waiting for it', async () => {
    const env = await makeEnv();
    await consent(env);
    const slow = slowInstallApply();
    const core = makeCore(env, { disposeTimeoutMs: 200 });
    const starting = core.start();
    await slow.entered;
    await core.dispose();
    // Dispose has given up on the attach and returned. The attach lands now, and must undo itself.
    slow.gate.open();
    const result = await starting;
    expect(result.ok).toBe(false);
    expect(await huddleHooksIn(env.settingsPath)).toBe(0);
    expect(core.setupStatus().attached).toBe(false);
  });

  it('undoes a Connect (setup.attach) whose write lands while quitting', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    const started = await core.start();
    expect(started.ok).toBe(true);
    const slow = slowInstallApply();
    const connecting = core.consentAndAttach();
    await slow.entered;
    const disposing = core.dispose();
    setTimeout(slow.gate.open, 50);
    await Promise.all([connecting, disposing]);
    expect(await huddleHooksIn(env.settingsPath)).toBe(0);
    expect(await core.command({ type: 'setup.attach' })).toMatchObject({ ok: false, code: 'failed' });
  });
});

describe('consent is stored only after the shown change is applied (finding 3)', () => {
  it('stores no consent when the change went stale', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    await fsp.writeFile(env.settingsPath, JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console' } }));
    expect((await core.consentAndAttach()).status).toBe('stale');
    expect(await readHuddleSettings(env.dataDir)).toMatchObject({ consentedAt: null, consentedFor: null });
    expect(core.setupStatus().consented).toBe(false);
  });

  it('stores no consent when the write failed', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    expect((await core.start()).ok).toBe(true);
    vi.spyOn(HookInstaller.prototype, 'apply').mockResolvedValue({ status: 'error', error: 'disk full' });
    expect(await core.consentAndAttach()).toEqual({ status: 'error', error: 'disk full' });
    expect(await readHuddleSettings(env.dataDir)).toMatchObject({ consentedAt: null, consentedFor: null });
  });

  it('stores consent after a successful write', async () => {
    const env = await makeEnv();
    const core = makeCore(env, { now: () => Date.UTC(2026, 10, 14, 9, 0, 0) });
    expect((await core.start()).ok).toBe(true);
    expect(await core.consentAndAttach()).toEqual({ status: 'attached', written: true });
    expect(await readHuddleSettings(env.dataDir)).toMatchObject({
      consentedAt: '2026-11-14T09:00:00.000Z',
      consentedFor: path.resolve(env.settingsPath),
    });
  });
});

describe('withdrawConsent (finding 3)', () => {
  it('clears the consent, removes the hooks and shows the first-run change again', async () => {
    const env = await makeEnv();
    await consent(env);
    const core = makeCore(env);
    const started = await core.start();
    if (!started.ok) throw new Error(started.message);
    expect(started.setup.attached).toBe(true);
    expect(await huddleHooksIn(env.settingsPath)).toBeGreaterThan(0);

    expect(await core.withdrawConsent()).toEqual({ ok: true });
    expect(await huddleHooksIn(env.settingsPath)).toBe(0);
    expect(await readHuddleSettings(env.dataDir)).toMatchObject({ consentedAt: null, consentedFor: null });
    expect(core.setupStatus()).toMatchObject({ consented: false, attached: false });
    expect(core.getState().connection?.status).toBe('needs_consent');

    // A restart does not attach by itself.
    await core.dispose();
    const again = makeCore(env);
    const restarted = await again.start();
    expect(restarted.ok && restarted.setup.attached).toBe(false);
    expect(await huddleHooksIn(env.settingsPath)).toBe(0);
  });
});
