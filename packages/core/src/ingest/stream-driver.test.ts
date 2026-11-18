import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HuddleEvent } from '@huddle/shared';
import {
  buildStreamArgs,
  interruptLine,
  killProcessTree,
  StreamDriver,
  type StreamDriverOptions,
  type StreamExit,
  type StreamStartOptions,
} from './stream-driver.js';

const FAKE = fileURLToPath(new URL('../test/fake-claude-stream.mjs', import.meta.url));
const SESSION = '0b6c7a52-3f7e-4f7a-9c38-1d2e3f4a5b6c';
const TIMEOUT = 30_000;
/** What the product code is asked to spawn; `spawn` below runs the fake under node instead. */
const CLAUDE = join(tmpdir(), 'abs', 'claude.exe');

let dir: string;
let logFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'huddle-stream-driver-'));
  logFile = join(dir, 'fake.log');
});
/** Every driver a test made; one a failed test left running is killed before its folder is removed. */
const live: StreamDriver[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((d) => d.stop({ graceMs: 0 })));
  rmSync(dir, { recursive: true, force: true });
});

interface FakeLog {
  argv: string[];
  agentsFile: { exists: boolean; names: string[] } | null;
  stdin: { type: string; request_id?: string; request?: Record<string, unknown>; message?: unknown }[];
}

function readLog(): FakeLog {
  const out: FakeLog = { argv: [], agentsFile: null, stdin: [] };
  if (!existsSync(logFile)) return out;
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line) as Partial<{
      argv: string[];
      agentsFile: FakeLog['agentsFile'];
      stdin: FakeLog['stdin'][number];
    }>;
    if (entry.argv !== undefined) out.argv = entry.argv;
    if (entry.agentsFile !== undefined) out.agentsFile = entry.agentsFile;
    if (entry.stdin !== undefined) out.stdin.push(entry.stdin);
  }
  return out;
}

const userTexts = (log: FakeLog) =>
  log.stdin.flatMap((m) => {
    if (m.type !== 'user') return [];
    const message = m.message as { content: { text: string }[] };
    return [message.content[0]?.text ?? ''];
  });

/** A driver whose spawn runs the fake under node, recording what the product code asked to spawn. */
function makeDriver(fakeEnv: Record<string, string> = {}, extra: Partial<StreamDriverOptions> = {}) {
  let n = 0;
  const spawned: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const killed: number[] = [];
  const driver = new StreamDriver({
    nextId: () => `id${String(++n)}`,
    now: Date.now,
    env: { ...process.env, FAKE_LOG: logFile, ...fakeEnv },
    command: CLAUDE,
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      return nodeSpawn(process.execPath, [FAKE, ...args], options);
    },
    kill: (pid) => {
      killed.push(pid);
      killProcessTree(pid);
    },
    ...extra,
  });
  live.push(driver);
  const events: HuddleEvent[] = [];
  const delivered: (string | null)[] = [];
  const exits: StreamExit[] = [];
  driver.onEvent((e) => events.push(e));
  driver.onDelivered((ref) => delivered.push(ref));
  driver.onExit((e) => exits.push(e));
  return { driver, spawned, killed, events, delivered, exits };
}

function startOptions(over: Partial<StreamStartOptions> = {}): StreamStartOptions {
  return { runId: 'run-1', sessionId: SESSION, cwd: dir, prompt: 'hello there', ...over };
}

/** Resolves when `check` is true, polling every 20 ms. */
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const results = (events: HuddleEvent[]) => events.filter((e) => e.type === 'run.result');

describe('buildStreamArgs', () => {
  it('builds the S16 argv and never takes a prompt', () => {
    expect(
      buildStreamArgs({
        sessionId: SESSION,
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        mainAgent: 'lead',
        agentsFile: 'C:/tmp/agents-run-1.json',
      }),
    ).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      SESSION,
      '--model',
      'sonnet',
      '--permission-mode',
      'acceptEdits',
      '--agents',
      'C:/tmp/agents-run-1.json',
      '--agent',
      'lead',
    ]);
  });

  it('refuses a non-UUID session id, an unknown mode and values that would read as flags', () => {
    expect(() => buildStreamArgs({ sessionId: 'abc' })).toThrow(/session id/);
    expect(() => buildStreamArgs({ sessionId: SESSION, permissionMode: 'yolo' })).toThrow(/permission mode/);
    expect(() => buildStreamArgs({ sessionId: SESSION, model: '--dangerously-skip-permissions' })).toThrow(/model/);
    expect(() => buildStreamArgs({ sessionId: SESSION, mainAgent: 'a\nb' })).toThrow(/agent/);
    expect(() => buildStreamArgs({ sessionId: SESSION, settingsFile: '--x' })).toThrow(/settings file/);
  });

  it('adds --settings <file> only when asked (exit harnesses, ADR-020 §1)', () => {
    expect(buildStreamArgs({ sessionId: SESSION })).not.toContain('--settings');
    expect(buildStreamArgs({ sessionId: SESSION, settingsFile: 'C:/h/settings.json' }).slice(-2)).toEqual([
      '--settings',
      'C:/h/settings.json',
    ]);
  });
});

describe('interruptLine', () => {
  it('adds cancel_queued only with the capability', () => {
    expect(JSON.parse(interruptLine('r1', ['interrupt_cancel_queued_v1']))).toEqual({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'interrupt', cancel_queued: true },
    });
    expect(JSON.parse(interruptLine('r2', ['interrupt_receipt_v1']))).toEqual({
      type: 'control_request',
      request_id: 'r2',
      request: { subtype: 'interrupt' },
    });
  });
});

describe('StreamDriver with a fake claude', () => {
  it(
    'starts with the prompt on stdin, not in argv, and spawns without a shell',
    async () => {
      const { driver, spawned, events, exits } = makeDriver();
      const { pid } = await driver.start(startOptions({ prompt: 'PROMPT-MARKER-xyz', model: 'sonnet' }));
      expect(pid).toBeGreaterThan(0);
      await until(() => results(events).length === 1);
      expect(driver.state).toBe('idle');
      expect(driver.end()).toEqual({ ok: true });
      const exit = await driver.exited;

      expect(spawned).toHaveLength(1);
      const call = spawned[0];
      expect(call?.command).toBe(CLAUDE);
      expect(call?.options).toMatchObject({ cwd: dir, shell: false, windowsHide: true });
      expect(call?.args.join(' ')).not.toContain('PROMPT-MARKER');
      const log = readLog();
      expect(log.argv).toEqual(call?.args);
      expect(log.argv).toEqual(expect.arrayContaining(['--session-id', SESSION, '--model', 'sonnet']));
      expect(userTexts(log)).toEqual(['PROMPT-MARKER-xyz']);

      expect(exit).toEqual({ exitCode: 0, signal: null, how: 'completed', error: null, undelivered: [] });
      expect(exits).toEqual([exit]);
      expect(driver.init).toMatchObject({ kind: 'init', sessionId: SESSION, toolCount: 2 });
      expect(events.map((e) => e.type)).toEqual(['limits.measured', 'run.result']);
      expect(events.every((e) => e.source === 'stream' && e.sessionId === SESSION)).toBe(true);
      expect(JSON.stringify(events)).not.toContain('answer to');
    },
    TIMEOUT,
  );

  it(
    'queues a message sent during a turn and writes it after the result',
    async () => {
      const { driver, events, delivered } = makeDriver();
      await driver.start(startOptions({ prompt: 'slow 1500' }));
      expect(driver.send('second message', 'm2')).toEqual({ ok: true, delivery: 'queued' });
      // The turn is running (its init arrived): nothing but the prompt reached stdin.
      await until(() => driver.init !== null && userTexts(readLog()).length === 1);
      expect(results(events)).toHaveLength(0);
      expect(userTexts(readLog())).toEqual(['slow 1500']);
      expect(delivered).toEqual([]);

      await until(() => results(events).length === 2);
      expect(delivered).toEqual(['m2']);
      expect(userTexts(readLog())).toEqual(['slow 1500', 'second message']);

      // Idle now: the next send is written at once.
      expect(driver.send('third', 'm3')).toEqual({ ok: true, delivery: 'written' });
      await until(() => results(events).length === 3);
      expect(delivered).toEqual(['m2', 'm3']);
      driver.end();
      expect((await driver.exited).how).toBe('completed');
      expect(driver.send('late')).toEqual({ ok: false, reason: 'exited' });
    },
    TIMEOUT,
  );

  it(
    'onIdle: after a result that leaves the run idle, not when its own queue is written or stdin is closed',
    async () => {
      const { driver, events } = makeDriver();
      const idleAt: number[] = [];
      let sendFromListener: string | null = 'from the idle listener';
      driver.onIdle(() => {
        idleAt.push(results(events).length);
        // A send from the listener is written at once (the run is idle).
        if (sendFromListener !== null) {
          expect(driver.send(sendFromListener, 'mi')).toEqual({ ok: true, delivery: 'written' });
          sendFromListener = null;
        }
      });
      await driver.start(startOptions({ prompt: 'slow 600' }));
      // Queued during the first turn: written at its result, so that result is not "idle".
      expect(driver.send('queued one', 'mq')).toEqual({ ok: true, delivery: 'queued' });
      // The second and third turns answer at once, so wait for both.
      await until(() => idleAt.length === 2);
      expect(idleAt).toEqual([2, 3]);
      expect(results(events)).toHaveLength(3);
      expect(userTexts(readLog())).toEqual(['slow 600', 'queued one', 'from the idle listener']);

      // Closing stdin during a turn: its result is not reported as idle.
      expect(driver.send('slow 300', 'ms')).toEqual({ ok: true, delivery: 'written' });
      await until(() => userTexts(readLog()).length === 4);
      driver.end();
      await driver.exited;
      expect(results(events)).toHaveLength(4);
      expect(idleAt).toEqual([2, 3]);
    },
    TIMEOUT,
  );

  it(
    'reports queued messages that were never written as undelivered',
    async () => {
      const { driver } = makeDriver();
      await driver.start(startOptions({ prompt: 'slow 400' }));
      expect(driver.send('will not go', 'm9')).toEqual({ ok: true, delivery: 'queued' });
      driver.end();
      expect(driver.send('after end')).toEqual({ ok: false, reason: 'ended' });
      const exit = await driver.exited;
      expect(exit).toMatchObject({ how: 'completed', undelivered: ['m9'] });
      expect(userTexts(readLog())).toEqual(['slow 400']);
    },
    TIMEOUT,
  );

  it(
    'interrupts with cancel_queued when init lists the capability; the process stays alive',
    async () => {
      const { driver, events } = makeDriver();
      await driver.start(startOptions({ prompt: 'slow 20000' }));
      expect(await driver.interrupt()).toEqual({ ok: false, reason: 'no_init', error: null });
      await until(() => driver.init !== null);
      const res = await driver.interrupt();
      expect(res).toMatchObject({ ok: true, requestId: expect.stringMatching(/^huddle-int-id\d+$/) as unknown });
      await until(() => results(events).length === 1);
      expect(results(events)[0]).toMatchObject({ isError: true });
      expect(driver.state).toBe('idle');
      expect(await driver.interrupt()).toEqual({ ok: false, reason: 'idle', error: null });

      const control = readLog().stdin.find((m) => m.type === 'control_request');
      expect(control).toEqual({
        type: 'control_request',
        request_id: res.ok ? res.requestId : 'none',
        request: { subtype: 'interrupt', cancel_queued: true },
      });
      // Still alive: it takes another message.
      expect(driver.send('after interrupt')).toEqual({ ok: true, delivery: 'written' });
      await until(() => results(events).length === 2);
      driver.end();
      expect((await driver.exited).how).toBe('completed');
    },
    TIMEOUT,
  );

  it(
    'interrupts without cancel_queued when the capability is missing',
    async () => {
      const { driver, events } = makeDriver({ FAKE_CAPS: 'interrupt_receipt_v1' });
      await driver.start(startOptions({ prompt: 'slow 20000' }));
      await until(() => driver.init !== null);
      expect((await driver.interrupt()).ok).toBe(true);
      await until(() => results(events).length === 1);
      const control = readLog().stdin.find((m) => m.type === 'control_request');
      expect(control?.request).toEqual({ subtype: 'interrupt' });
      await driver.stop();
    },
    TIMEOUT,
  );

  it(
    'stop: interrupts the turn, closes stdin, and reports how stopped without a hard kill',
    async () => {
      const { driver, killed, events, exits } = makeDriver();
      await driver.start(startOptions({ prompt: 'slow 20000' }));
      await until(() => driver.init !== null);
      const exit = await driver.stop({ graceMs: 8000 });
      expect(exit).toMatchObject({ how: 'stopped', exitCode: 0, error: null });
      expect(exits).toHaveLength(1);
      expect(killed).toEqual([]);
      expect(results(events)[0]).toMatchObject({ isError: true });
      expect(readLog().stdin.map((m) => m.type)).toEqual(['user', 'control_request']);
      expect(driver.send('x')).toEqual({ ok: false, reason: 'exited' });
      // A second stop is harmless.
      expect(await driver.stop()).toEqual(exit);
    },
    TIMEOUT,
  );

  it(
    'stop: ends the process hard when it ignores stdin closing',
    async () => {
      const { driver, killed, exits } = makeDriver({ FAKE_IGNORE_EOF: '1' });
      const { pid } = await driver.start(startOptions({ prompt: 'quick' }));
      await until(() => driver.state === 'idle');
      const startedAt = Date.now();
      const exit = await driver.stop({ graceMs: 600 });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
      expect(killed).toEqual([pid]);
      expect(exit?.how).toBe('stopped');
      expect(exit?.error).toBeNull();
      expect(exit?.exitCode === 0).toBe(false);
      expect(exits).toEqual([exit]);
    },
    TIMEOUT,
  );

  it(
    'stop: the grace timer is cleared when the process exits first (nothing keeps the event loop alive)',
    async () => {
      const { driver, killed } = makeDriver();
      await driver.start(startOptions({ prompt: 'quick' }));
      await until(() => driver.state === 'idle');
      const realSetTimeout = globalThis.setTimeout;
      const graceTimers: ReturnType<typeof setTimeout>[] = [];
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
        const handle = realSetTimeout(fn, ms);
        if ((ms ?? 0) > 5000) graceTimers.push(handle);
        return handle;
      });
      const cleared = vi.spyOn(globalThis, 'clearTimeout');
      try {
        const exit = await driver.stop({ graceMs: 8000 });
        expect(exit?.how).toBe('stopped');
      } finally {
        spy.mockRestore();
      }
      expect(killed).toEqual([]);
      expect(graceTimers.length).toBeGreaterThan(0);
      for (const t of graceTimers) expect(cleared).toHaveBeenCalledWith(t);
      cleared.mockRestore();
    },
    TIMEOUT,
  );

  it(
    'stop with graceMs 0 kills at once',
    async () => {
      const { driver, killed } = makeDriver();
      const { pid } = await driver.start(startOptions({ prompt: 'slow 20000' }));
      const exit = await driver.stop({ graceMs: 0 });
      expect(killed).toEqual([pid]);
      expect(exit?.how).toBe('stopped');
    },
    TIMEOUT,
  );

  it(
    'a non-zero exit is failed, with the end of stderr as the error',
    async () => {
      const { driver } = makeDriver();
      await driver.start(startOptions({ prompt: 'fail' }));
      const exit = await driver.exited;
      expect(exit).toMatchObject({ how: 'failed', exitCode: 3, error: 'fatal: boom' });
    },
    TIMEOUT,
  );

  it(
    'reads output split mid-line with CRLF endings',
    async () => {
      const { driver, events } = makeDriver({ FAKE_CHUNKY: '1' });
      await driver.start(startOptions({ prompt: 'quick' }));
      await until(() => results(events).length === 1);
      driver.end();
      await driver.exited;
      expect(driver.stats).toMatchObject({ unreadLines: 0, oversizedLines: 0 });
      expect(driver.stats.lines).toBe(4); // init, rate_limit_event, assistant, result: none torn
      expect(driver.init?.capabilities).toContain('interrupt_cancel_queued_v1');
    },
    TIMEOUT,
  );

  it(
    'writes --agents to a temp file that the process reads and that is removed on exit',
    async () => {
      const { driver, spawned } = makeDriver();
      await driver.start(
        startOptions({
          tempDir: dir,
          mainAgent: 'lead',
          agents: {
            lead: { description: 'Leads', prompt: 'You lead.', tools: ['Read'] },
            helper: { description: 'Helps', prompt: 'You help.' },
          },
        }),
      );
      const file = join(dir, 'agents-run-1.json');
      const args = spawned[0]?.args ?? [];
      expect(args[args.indexOf('--agents') + 1]).toBe(file);
      expect(args[args.indexOf('--agent') + 1]).toBe('lead');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        lead: { description: 'Leads', prompt: 'You lead.', tools: ['Read'] },
        helper: { description: 'Helps', prompt: 'You help.' },
      });
      await until(() => driver.state === 'idle');
      expect(readLog().agentsFile).toEqual({ exists: true, names: ['lead', 'helper'] });
      driver.end();
      await driver.exited;
      expect(existsSync(file)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'rejects when the binary does not exist, removes the agents file, and reports no exit',
    async () => {
      const exits: StreamExit[] = [];
      const driver = new StreamDriver({
        nextId: () => 'x',
        now: Date.now,
        command: join(dir, 'no-such-claude.exe'),
      });
      driver.onExit((e) => exits.push(e));
      await expect(
        driver.start(startOptions({ tempDir: dir, agents: { a: { description: 'd', prompt: 'p' } } })),
      ).rejects.toThrow(/could not start claude/);
      expect(existsSync(join(dir, 'agents-run-1.json'))).toBe(false);
      expect(driver.state).toBe('exited');
      expect(exits).toEqual([]);
      expect(driver.send('x')).toEqual({ ok: false, reason: 'exited' });
      await expect(driver.start(startOptions())).rejects.toThrow(/already started/);
      expect(await driver.stop()).toBeNull();
    },
    TIMEOUT,
  );

  it('rejects bad options before spawning', async () => {
    const { driver, spawned } = makeDriver();
    await expect(driver.start(startOptions({ sessionId: 'not-a-uuid' }))).rejects.toThrow(/session id/);
    expect(spawned).toEqual([]);
    const second = makeDriver();
    await expect(
      second.driver.start(startOptions({ agents: { a: { description: 'd', prompt: 'p' } } })),
    ).rejects.toThrow(/tempDir/);
    const third = makeDriver();
    await expect(third.driver.start(startOptions({ prompt: '   ' }))).rejects.toThrow(/prompt/);
  });

  it('refuses controls before start', async () => {
    const { driver } = makeDriver();
    expect(driver.send('x')).toEqual({ ok: false, reason: 'not_started' });
    expect(driver.end()).toEqual({ ok: false, reason: 'not_started' });
    expect(await driver.interrupt()).toEqual({ ok: false, reason: 'not_started', error: null });
    expect(driver.state).toBe('not_started');
    expect(await driver.stop()).toBeNull();
  });
});
