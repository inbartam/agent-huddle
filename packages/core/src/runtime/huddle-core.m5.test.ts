/**
 * HuddleCore and the M5 history service (WP4b, F22 F23 F24), end to end: hooks in, a run ends, its report is written
 * after the batch is stored; the M5 queries and report commands go through `query()` / `command()`; and the hook
 * server keeps answering quickly while a replay of a 20 000-event session is being built.
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult } from '@huddle/shared';
import { renderReportMarkdown } from '../report/markdown.js';
import { buildRunReport } from '../report/run-report.js';
import { SqliteEventStore } from '../store/sqlite-store.js';
import { readFixture } from '../test/fixtures.js';
import { appendAll, longSession, readBack } from '../test/history-sessions.js';
import { HuddleCore, type HuddleCoreDeps } from './huddle-core.js';
import { reportPathFor } from './report-files.js';

const TOKEN = 'test-token-0123456789';
const DAY = 24 * 60 * 60 * 1000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Env {
  root: string;
  dataDir: string;
  claudeDir: string;
  forwarder: string;
}

async function makeEnv(): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-core-m5-'));
  const env = {
    root,
    dataDir: path.join(root, 'data'),
    claudeDir: path.join(root, 'claude'),
    forwarder: path.join(root, 'forwarder.mjs'),
  };
  await fsp.mkdir(env.claudeDir, { recursive: true });
  await fsp.writeFile(env.forwarder, '// test forwarder\n');
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5 }));
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
    history: { reportDelayMs: 0 },
    ...extra,
  });
  cleanups.push(() => core.dispose());
  return core;
}

function post(port: number, route: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'x-huddle-token': TOKEN,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

/** The hook lines of a fixture as session `sessionId`. */
function hookLines(fixture: string, sessionId: string): { event: string; payload: Record<string, unknown> }[] {
  return readFixture(fixture)
    .filter((line) => line.kind === 'hook')
    .map((line) => ({
      event: line.event ?? 'x',
      payload: { ...(line.payload as Record<string, unknown>), session_id: sessionId },
    }));
}

async function started(core: HuddleCore): Promise<number> {
  const result = await core.start();
  if (!result.ok) throw new Error(result.message);
  return result.port;
}

function ok(result: QueryResult): Extract<QueryResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

describe('reports on session end, through the hooks', () => {
  it('writes <dataDir>/reports/<id>.md after SessionEnd is stored, equal to the report of the stored events', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    const port = await started(core);
    const id = 'sess-m5-end';
    for (const line of hookLines('single-agent.jsonl', id)) {
      expect(await post(port, `/huddle/hooks/${line.event}`, line.payload)).toBe(200);
    }
    const file = reportPathFor(env.dataDir, id) ?? '';
    await vi.waitFor(
      async () => {
        await core.flushReports();
        await fsp.access(file);
      },
      { timeout: 5000, interval: 50 },
    );
    const answer = ok(await core.query({ type: 'report.get', sessionId: id }));
    if (answer.type !== 'report.get' || answer.answer.status !== 'ready') throw new Error('not ready');
    await core.dispose();
    const store = new SqliteEventStore({ file: path.join(env.dataDir, 'huddle.sqlite') });
    try {
      const expected = buildRunReport(await readBack(store, id), id);
      if (expected === null) throw new Error('no report');
      expect(answer.answer.report).toEqual(expected);
      expect(await fsp.readFile(file, 'utf8')).toBe(renderReportMarkdown(expected));
    } finally {
      await store.close();
    }
  });

  it('answers the M5 queries and report commands instead of not_available', async () => {
    const env = await makeEnv();
    const core = makeCore(env);
    const port = await started(core);
    const id = 'sess-m5-q';
    for (const line of hookLines('permission-deny.jsonl', id)) {
      if (line.event === 'PermissionRequest') continue; // would be held for the user
      expect(await post(port, `/huddle/hooks/${line.event}`, line.payload)).toBe(200);
    }
    await vi.waitFor(async () => {
      const list = ok(await core.query({ type: 'history.list', limit: 10 }));
      if (list.type !== 'history.list') throw new Error(list.type);
      expect(list.page.rows.map((r) => r.sessionId)).toContain(id);
    });
    const open = ok(await core.query({ type: 'history.open', sessionId: id }));
    expect(open.type).toBe('history.open');
    // The end-of-run report (delay 0) is written first, so report.make below does not depend on when its timer fires.
    // (They used to race over the same file and the second rename failed on Windows with EPERM; the per-session
    // writer now serializes them, and history.test.ts covers the overlap itself.)
    await core.flushReports();
    await expect(core.command({ type: 'report.make', sessionId: id })).resolves.toEqual({
      ok: true,
      detail: reportPathFor(env.dataDir, id),
    });
    await expect(core.command({ type: 'report.copyPath', sessionId: id })).resolves.toEqual({
      ok: true,
      detail: reportPathFor(env.dataDir, id),
    });
    await expect(core.command({ type: 'report.openFile', sessionId: '../x' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid',
    });
    // WP6: answered while Ask is off (the default); the session that just reported is in the summary.
    const preview = ok(await core.query({ type: 'ask.preview', question: 'what now?' }));
    if (preview.type !== 'ask.preview') throw new Error(preview.type);
    expect(preview.preview.text).toMatch(new RegExp(`Session: "[^"]+", session ${id}`));
    await expect(core.query({ type: 'history.open', sessionId: '../x' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});

/**
 * Why 50 ms. A hook's own answer has a 20 ms budget inside the core; this measures more than that: a real HTTP round
 * trip over loopback with the client in the same process and event loop, so it includes the client's own work and any
 * GC pause. The replay folds 250 rows between yields (measured at most about 3 ms per chunk on the owner's machine),
 * so a hook waits for at most one chunk; measured p99 was 9-23 ms with a 1-2 ms p50 baseline. 50 ms leaves room for a
 * loaded machine (other test workers). The stronger guard is `answeredDuringReplay`: a replay that folded all 20 000
 * events without yielding would hold the loop for the whole build (about 80 chunks of 0.5-5 ms) and let at most one
 * answer through while it runs.
 */
describe('hook answers while a long replay is built', () => {
  it('keeps the hook round trip p99 under 50 ms during stateAt over 20 000 events', async () => {
    const env = await makeEnv();
    const id = 'sess-long';
    const events = longSession('single-agent.jsonl', id, 20_000, Date.now() - 3 * DAY);
    const seed = new SqliteEventStore({ file: path.join(env.dataDir, 'huddle.sqlite') });
    await appendAll(seed, events, 5000);
    await seed.close();

    // No start-up backfill: the replay below is the only long work, so what is measured is the replay.
    const core = makeCore(env, { history: { reportDelayMs: 0, backfillAtStart: false } });
    const port = await started(core);

    const lines = hookLines('single-agent.jsonl', 'sess-hooks').filter((l) => l.event === 'PreToolUse');
    // Warm up the hook path first (a new session, the first compiles of normalize, reduce and the HTTP path): its
    // first answers take 20-50 ms with or without a replay running, which is not what this test is about. The same
    // posts give the baseline with nothing else running.
    const base: number[] = [];
    for (let k = 0; k < 60; k++) {
      const line = lines[k % lines.length];
      if (line === undefined) throw new Error('no PreToolUse line');
      const t0 = performance.now();
      expect(await post(port, `/huddle/hooks/${line.event}`, line.payload)).toBe(200);
      base.push(performance.now() - t0);
    }
    const baseP50 = [...base].sort((a, b) => a - b)[base.length >> 1] ?? 0;

    const replay = { done: false };
    const replayed = core.query({ type: 'history.stateAt', sessionId: id, index: events.length - 1 }).finally(() => {
      replay.done = true;
    });
    const times: number[] = [];
    let answeredDuringReplay = 0;
    let n = 0;
    while (!replay.done || times.length < 20) {
      const line = lines[n % lines.length];
      if (line === undefined) throw new Error('no PreToolUse line');
      n += 1;
      const t0 = performance.now();
      const running = !replay.done;
      expect(await post(port, `/huddle/hooks/${line.event}`, line.payload)).toBe(200);
      times.push(performance.now() - t0);
      if (running) answeredDuringReplay += 1;
    }
    // A replay that held the event loop until it was done would let at most one answer through meanwhile.
    expect(answeredDuringReplay).toBeGreaterThanOrEqual(10);
    const moment = ok(await replayed);
    if (moment.type !== 'history.stateAt') throw new Error(moment.type);
    expect(moment.moment.eventCount).toBe(events.length);
    expect(moment.moment.index).toBe(events.length - 1);

    times.sort((a, b) => a - b);
    const p99 = times[Math.min(times.length - 1, Math.ceil(times.length * 0.99) - 1)] ?? Infinity;
    const p50 = times[Math.floor(times.length / 2)] ?? Infinity;
    console.log(
      `hook round trips during a 20k-event replay: n=${String(times.length)} ` +
        `(during=${String(answeredDuringReplay)}) p50=${p50.toFixed(1)} ms ` +
        `p99=${p99.toFixed(1)} ms max=${(times.at(-1) ?? 0).toFixed(1)} ms; without a replay p50=${baseP50.toFixed(1)} ms`,
    );
    expect(times.length).toBeGreaterThanOrEqual(20);
    expect(p99).toBeLessThan(50);

    // A moment in the middle comes from the nearest checkpoint, quickly.
    const t0 = performance.now();
    const middle = ok(await core.query({ type: 'history.stateAt', sessionId: id, index: 10_250 }));
    expect(middle.type).toBe('history.stateAt');
    expect(performance.now() - t0).toBeLessThan(1000);
  }, 120_000);
});
