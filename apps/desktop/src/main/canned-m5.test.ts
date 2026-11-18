/**
 * M5 (WP4a): the canned history behind `HUDDLE_DEV_CANNED=1`, through the same IPC handlers the app uses, and the
 * real core's interim "not available" answer for the M5 questions.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  type HuddleQuery,
  type HuddleState,
  type QueryResult,
  type QueryResultOf,
  type UserSettings,
} from '@huddle/shared';
import { createCannedCore } from './canned-core.js';
import { M5_SESSIONS } from './canned-m5.js';
import type { CoreHost } from './core-host.js';
import { createIpcHandlers } from './ipc.js';
import { createCoreSettingsHost, createMemorySettingsHost } from './settings-host.js';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }, ipcMain: {} }));

function handlers() {
  const host = createMemorySettingsHost(createCannedCore(), DEFAULT_USER_SETTINGS);
  return { host, h: createIpcHandlers(host) };
}

async function ok<T extends HuddleQuery['type']>(
  h: ReturnType<typeof createIpcHandlers>,
  q: { type: T } & Record<string, unknown>,
): Promise<QueryResultOf<T>> {
  const r: QueryResult = await h.query(q, null);
  if (!r.ok || r.type !== q.type) throw new Error(`expected ok ${q.type}, got ${JSON.stringify(r)}`);
  // Everything crossing IPC must survive structured cloning as plain JSON.
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  return r as QueryResultOf<T>;
}

describe('canned history', () => {
  it('lists runs newest first with every outcome the UI shows', async () => {
    const { h } = handlers();
    const r = await ok(h, { type: 'history.list', limit: 200 });
    const rows = r.page.rows;
    expect(rows.map((row) => row.startTs)).toEqual([...rows.map((row) => row.startTs)].sort((a, b) => b - a));
    const outcomes = new Set(rows.map((row) => row.outcome));
    for (const o of ['completed', 'failed', 'no_end', 'running'] as const) expect(outcomes).toContain(o);
    const fix = rows.find((row) => row.sessionId === M5_SESSIONS.fix);
    expect(fix).toMatchObject({ title: 'Fix parser tests', origin: 'managed', agentCount: 3, otherModels: 2 });
    expect(fix?.tokens?.value).toBeGreaterThan(0);
    const untitled = rows.find((row) => row.sessionId === M5_SESSIONS.summarize);
    expect(untitled).toMatchObject({ title: null, topic: 'summarize the repo', durationMs: null, outcome: 'no_end' });
  });

  it('pages with a cursor and filters by outcome and folder', async () => {
    const { h } = handlers();
    const first = await ok(h, { type: 'history.list', limit: 1 });
    expect(first.page.rows).toHaveLength(1);
    expect(first.page.next).not.toBeNull();
    const second = await ok(h, { type: 'history.list', limit: 1, before: first.page.next });
    expect(second.page.rows[0]?.sessionId).not.toBe(first.page.rows[0]?.sessionId);
    const failed = await ok(h, { type: 'history.list', limit: 50, outcome: 'failed' });
    expect(failed.page.rows.map((row) => row.sessionId)).toEqual([M5_SESSIONS.migrate]);
    const folders = await ok(h, { type: 'history.folders' });
    expect(folders.folders).toContain('C:\\code\\voice-scout');
    const scout = await ok(h, { type: 'history.list', limit: 50, folder: 'C:\\code\\voice-scout' });
    expect(scout.page.rows.map((row) => row.sessionId)).toEqual([M5_SESSIONS.summarize]);
  });

  it('search returns plain text and offsets, never markup', async () => {
    const { h } = handlers();
    const r = await ok(h, { type: 'history.search', text: 'SQLite', limit: 20 });
    expect(r.page.total).toBe(1);
    const hit = r.page.hits[0];
    expect(hit?.row.sessionId).toBe(M5_SESSIONS.migrate);
    const match = hit?.match;
    expect(match?.field).toBe('topic');
    const range = match?.ranges[0];
    expect(match?.text.slice(range?.start, range?.end)).toBe('SQLite');
    expect(match?.text).not.toMatch(/<|>/);
  });

  it('search returns title and folder matches whole, with every place the words are (like the core)', async () => {
    const { h } = handlers();
    const title = await ok(h, { type: 'history.search', text: 'migrate', limit: 20 });
    expect(title.page.hits.find((x) => x.row.sessionId === M5_SESSIONS.migrate)?.match).toEqual({
      field: 'title',
      text: 'Migrate store',
      cutStart: false,
      cutEnd: false,
      ranges: [{ start: 0, end: 7 }],
    });
    const folder = await ok(h, { type: 'history.search', text: 'scout', limit: 20 });
    expect(folder.page.hits.map((x) => x.match)).toEqual([
      {
        field: 'folder',
        text: 'C:\\code\\voice-scout',
        cutStart: false,
        cutEnd: false,
        ranges: [{ start: 14, end: 19 }],
      },
    ]);
  });

  it('the live run is named as the team names it, and its replayed tree has every agent of the team', async () => {
    const { h, host } = handlers();
    const live = (await ok(h, { type: 'history.list', limit: 200 })).page.rows.find((r) => r.outcome === 'running');
    expect(live).toMatchObject({
      title: 'Refactor the parser',
      topic: 'Split the parser into a tokenizer and a parser, keep the tests green',
    });
    if (!live) throw new Error('no live run');
    const head = await ok(h, { type: 'history.open', sessionId: live.sessionId });
    const at = await ok(h, { type: 'history.stateAt', sessionId: live.sessionId, index: head.head.eventCount - 1 });
    const team = Object.values(host.getState().agents).filter((a) => a.sessionId === live.sessionId);
    const replayed = new Map(Object.values(at.moment.state.agents).map((a) => [a.key, a.name]));
    for (const a of team) expect(replayed.get(a.key)).toBe(a.name);
    // The approval the test-engineer waits on is titled with the same name the tree shows.
    expect(at.moment.why.find((w) => w.kind === 'approval')?.title).toBe('Write parser tests needs approval');
  });

  it('replays the stuck incident with its why-facts', async () => {
    const { h } = handlers();
    const head = await ok(h, { type: 'history.open', sessionId: M5_SESSIONS.fix });
    expect(head.head.startsWithSession).toBe(true);
    expect(head.head.hasReport).toBe(true);
    const kinds = head.head.markers.map((m) => m.kind);
    expect(kinds).toContain('approval');
    expect(kinds).toContain('stuck');
    expect(head.head.quietGaps.some((g) => g.ms >= 12 * 60_000)).toBe(true);

    const stuck = head.head.markers.find((m) => m.kind === 'stuck');
    if (stuck === undefined) throw new Error('no stuck marker');
    const at = await ok(h, { type: 'history.stateAt', sessionId: M5_SESSIONS.fix, index: stuck.index });
    const m = at.moment;
    expect(m.event).toMatchObject({ index: stuck.index, type: 'attention.raised', agentKey: stuck.agentKey });
    expect(Object.keys(m.state.agents).every((k) => k.startsWith(M5_SESSIONS.fix))).toBe(true);
    expect('book' in m.state).toBe(false);
    const why = m.why.find((w) => w.kind === 'stuck');
    expect(why).toMatchObject({
      agentKey: stuck.agentKey,
      lastToolCall: { toolName: 'Bash', summary: 'npm test -- parser', fate: { state: 'open' } },
      later: { kind: 'cleared', reason: 'condition_cleared' },
    });
    expect(why?.quietMs).toBe(12 * 60_000);

    const past = await ok(h, { type: 'history.stateAt', sessionId: M5_SESSIONS.fix, index: 1_000_000 });
    expect(past.moment.index).toBe(head.head.eventCount - 1);
  });

  it('pages events forward and backward, slim unless full', async () => {
    const { h } = handlers();
    const fwd = await ok(h, { type: 'history.events', sessionId: M5_SESSIONS.fix, fromIndex: 0, limit: 3 });
    expect(fwd.page.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(fwd.page.more).toBe(true);
    expect(fwd.page.entries[0]?.event).toBeUndefined();
    const back = await ok(h, {
      type: 'history.events',
      sessionId: M5_SESSIONS.fix,
      fromIndex: 10,
      limit: 2,
      backward: true,
      full: true,
    });
    expect(back.page.entries.map((e) => e.index)).toEqual([10, 9]);
    expect(back.page.entries[0]?.event?.type).toBe(back.page.entries[0]?.type);
  });

  it('answers report.get as ready, none and not_ready', async () => {
    const { h, host } = handlers();
    const ready = await ok(h, { type: 'report.get', sessionId: M5_SESSIONS.fix });
    expect(ready.answer.status).toBe('ready');
    if (ready.answer.status === 'ready') {
      expect(ready.answer.report.summary.outcome).toBe('completed');
      expect(ready.answer.report.summary.stuckIncidents).toBe(1);
      expect(ready.answer.file?.exists).toBe(true);
    }
    expect((await ok(h, { type: 'report.get', sessionId: M5_SESSIONS.migrate })).answer.status).toBe('none');
    const live = host.getState().rootKeys[0] ?? '';
    expect((await ok(h, { type: 'report.get', sessionId: live })).answer.status).toBe('not_ready');
    expect(await h.command({ type: 'report.make', sessionId: M5_SESSIONS.migrate })).toMatchObject({ ok: true });
    expect((await ok(h, { type: 'report.get', sessionId: M5_SESSIONS.migrate })).answer.status).toBe('ready');
    expect(await h.query({ type: 'report.get', sessionId: 'no-such-run' }, null)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('has scorecards with two models on one role, one of them below the prior threshold', async () => {
    const { h } = handlers();
    const r = await ok(h, { type: 'scorecards.get' });
    const core = r.answer.scorecards.filter((c) => c.role === 'core-engineer');
    expect(core).toHaveLength(2);
    expect(core.map((c) => c.sampleSize).sort((a, b) => a - b)).toEqual([2, 10]);
  });

  it('answers stats, the retention preview and the Ask preview', async () => {
    const { h } = handlers();
    expect((await ok(h, { type: 'history.stats' })).stats.runs).toBeGreaterThanOrEqual(4);
    const keep1 = await ok(h, { type: 'history.retentionPreview', days: 1 });
    expect(keep1.preview.runs).toBe(2);
    const p = (await ok(h, { type: 'ask.preview', question: 'why is it slow?' })).preview;
    expect(p.parts.map((x) => x.part)).toEqual(['instructions', 'question', 'summary']);
    const q = p.parts[1];
    expect(q ? p.text.slice(q.start, q.end) : '').toContain('why is it slow?');
    expect(p.bytes).toBe(Buffer.byteLength(p.text, 'utf8'));
    // A system prompt, so the "Instructions to the model (system prompt)" part shows with HUDDLE_DEV_CANNED.
    expect(p.systemPrompt).toMatch(/^Sample system prompt \(canned data\)\./);
  });

  it('the Ask preview and the canned answer carry a follow-up history part', async () => {
    const { h } = handlers();
    const history = [1, 2, 3, 4].map((n) => ({ question: `q${String(n)}`, answer: `a${String(n)}` }));
    const p = (await ok(h, { type: 'ask.preview', question: 'and now?', history })).preview;
    expect(p.parts.map((x) => x.part)).toEqual(['instructions', 'history', 'question', 'summary']);
    const part = p.parts[1];
    const text = part ? p.text.slice(part.start, part.end) : '';
    expect(text).toContain('<huddle-history>');
    expect(text).not.toContain('q1');
    expect(text).toContain('Q: q4\nA: a4');
    expect(await h.command({ type: 'ask.setEnabled', enabled: true })).toEqual({ ok: true });
    vi.useFakeTimers();
    try {
      const answer = h.command({ type: 'huddle.ask', question: 'and now?', history });
      await vi.advanceTimersByTimeAsync(2000);
      const r = await answer;
      expect(r.ok && r.ask?.sent).toContain('Q: q4\nA: a4');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to ask while Ask is off, answers once it is on, and cancels', async () => {
    const { h, host } = handlers();
    expect(await h.command({ type: 'huddle.ask', question: 'why?' })).toMatchObject({
      ok: false,
      askError: 'disabled',
    });
    expect(await h.command({ type: 'ask.setEnabled', enabled: true })).toEqual({ ok: true });
    expect(host.settings().ask.enabled).toBe(true);
    vi.useFakeTimers();
    try {
      const answer = h.command({ type: 'huddle.ask', question: 'why?' });
      expect(await h.command({ type: 'huddle.ask', question: 'again?' })).toMatchObject({ askError: 'busy' });
      await vi.advanceTimersByTimeAsync(2000);
      const r = await answer;
      expect(r.ok && r.ask?.sent).toContain('Question: why?');
      const cancelled = h.command({ type: 'huddle.ask', question: 'slow?' });
      await vi.advanceTimersByTimeAsync(0);
      expect(await h.command({ type: 'ask.cancel' })).toEqual({ ok: true });
      expect(await cancelled).toMatchObject({ ok: false, askError: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the retention in the memory settings', async () => {
    const { h, host } = handlers();
    expect(await h.command({ type: 'history.setRetention', days: 7 })).toEqual({ ok: true });
    expect(host.settings().history.retentionDays).toBe(7);
    expect((host.getState().settings as UserSettings).history.retentionDays).toBe(7);
    expect(await h.command({ type: 'history.setRetention', days: 0 })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('the real core host', () => {
  it('passes checked M5 questions and settings commands to the core, and refuses bad ones itself', async () => {
    const answer: QueryResult = { ok: false, code: 'not_available', message: 'not yet' };
    const query = vi.fn((): Promise<QueryResult> => Promise.resolve(answer));
    const command = vi.fn(() => Promise.resolve({ ok: true as const }));
    const fake: CoreHost & { getUserSettings(): UserSettings } = {
      getState: (): HuddleState => ({ agents: {}, rootKeys: [], inbox: [], rateLimits: null }),
      getEvents: () => [],
      command,
      query,
      onEvents: () => () => undefined,
      dispose: () => Promise.resolve(),
      getUserSettings: () => DEFAULT_USER_SETTINGS,
    };
    const h = createIpcHandlers(createCoreSettingsHost(fake));
    expect(await h.query({ type: 'history.list', limit: 5000 }, null)).toEqual(answer);
    expect(query).toHaveBeenCalledWith({ type: 'history.list', limit: 200 });
    expect(await h.query({ type: 'history.open', sessionId: '..' }, null)).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(await h.command({ type: 'ask.setEnabled', enabled: true })).toEqual({ ok: true });
    expect(command).toHaveBeenCalledWith({ type: 'ask.setEnabled', enabled: true });
  });
});
