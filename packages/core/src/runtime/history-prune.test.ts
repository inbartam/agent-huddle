/**
 * HistoryService deletion (M5 WP5): the retention list is what the preview counts, deletion runs in small transactions
 * with a yield between them, a live run is never on the list, and a report in flight finishes before its file goes.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, type QueryResult } from '@huddle/shared';
import { initialState } from '../state/reduce.js';
import { appendAll, fixtureSession, longSession, tempStore } from '../test/history-sessions.js';
import { HistoryService, type HistoryServiceDeps } from './history.js';
import { reportPathFor } from './report-files.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const BUDGETS = 'huddle-budgets';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(over: Partial<HistoryServiceDeps> = {}) {
  const tmp = await tempStore('huddle-history-prune-');
  let yields = 0;
  const service = new HistoryService({
    store: tmp.store,
    dataDir: tmp.dir,
    now: () => NOW,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    liveState: () => initialState(),
    startedAt: () => null,
    settings: () => DEFAULT_USER_SETTINGS,
    migrating: () => false,
    track: (work) => work,
    exclude: [BUDGETS],
    keep: [BUDGETS],
    reportDelayMs: 0,
    yieldNow: () => {
      yields += 1;
      return Promise.resolve();
    },
    ...over,
  });
  cleanups.push(async () => {
    service.dispose();
    await tmp.cleanup();
  });
  return { tmp, service, yields: () => yields };
}

async function previewRuns(service: HistoryService, days: number): Promise<number | null> {
  const r: QueryResult = await service.query({ type: 'history.retentionPreview', days });
  if (!r.ok || r.type !== 'history.retentionPreview') throw new Error('preview failed');
  return r.preview.runs;
}

describe('HistoryService deletion', () => {
  it('deletes exactly the previewed runs, in chunks with a yield between them, never a live run', async () => {
    const { tmp, service, yields } = await setup({ pruneChunkRows: 50, isRunLive: (id) => id === 'live' });
    const long = longSession('single-agent.jsonl', 'long-old', 600, NOW - 20 * DAY);
    await appendAll(tmp.store, [
      ...long,
      ...fixtureSession('single-agent.jsonl', 'short-old', { lastTs: NOW - 15 * DAY }),
      ...fixtureSession('single-agent.jsonl', 'live', { lastTs: NOW - 30 * DAY, dropEnd: true }),
      ...fixtureSession('single-agent.jsonl', 'new', { lastTs: NOW - DAY }),
    ]);
    const counted = await previewRuns(service, 7);
    const ids = await service.retentionCandidates(7);
    expect(counted).toBe(2);
    expect(ids).toEqual(['long-old', 'short-old']);

    const before = yields();
    const outcome = await service.deleteSessions(ids);
    expect(outcome.deleted).toEqual(ids);
    expect(outcome.deleted.length).toBe(counted);
    expect(outcome.events).toBe(long.length + 25);
    // At least one yield per 50 events of the long session.
    expect(yields() - before).toBeGreaterThanOrEqual(Math.ceil(long.length / 50));
    expect(await previewRuns(service, 7)).toBe(0);
    expect((await tmp.store.listSessionRecords()).map((r) => r.sessionId).sort()).toEqual(['live', 'new']);
  });

  it('removes the report file of a deleted run, also one written just before', async () => {
    const { tmp, service } = await setup();
    await appendAll(tmp.store, fixtureSession('single-agent.jsonl', 'with-report', { lastTs: NOW - 40 * DAY }));
    const made = await service.makeReportCommand('with-report');
    expect(made.ok).toBe(true);
    const file = reportPathFor(tmp.dir, 'with-report');
    expect(file).not.toBeNull();
    if (file === null) return;
    await fsp.access(file);
    const outcome = await service.deleteSessions(['with-report']);
    expect(outcome).toMatchObject({ deleted: ['with-report'], reports: 1 });
    await expect(fsp.access(file)).rejects.toThrow();
    expect(tmp.store.history.agentRuns([])).toEqual([]);
  });

  it('report.make made while the deletion runs writes no file; the run is gone and stays without one', async () => {
    // The deletion pauses at its first yield (5 events deleted, the `sessions` row and the current derivation still
    // there, so report.make has a report to write). The rename of any write report.make starts is held until the
    // deletion has finished: before the writer refused deleted sessions, that write landed after the file was removed
    // and the report outlived "delete".
    let pauseNext = false;
    let paused: () => void = () => undefined;
    const pausedAt = new Promise<void>((resolve) => {
      paused = resolve;
    });
    let resume: () => void = () => undefined;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached: () => void = () => undefined;
    const renameReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let openRename: () => void = () => undefined;
    const renameGate = new Promise<void>((resolve) => {
      openRename = resolve;
    });
    const { tmp, service } = await setup({
      pruneChunkRows: 5,
      yieldNow: () => {
        if (!pauseNext) return Promise.resolve();
        pauseNext = false;
        paused();
        return resumed;
      },
      reportFileOps: {
        rename: async (from, to) => {
          reached();
          await renameGate;
          await fsp.rename(from, to);
        },
      },
    });
    const id = 'deleted-while-made';
    const events = fixtureSession('single-agent.jsonl', id, { lastTs: NOW - 40 * DAY });
    await appendAll(tmp.store, events);
    // Derived, as any run listed or opened before is: report.make writes from the stored report.
    await service.backfill();
    const file = reportPathFor(tmp.dir, id) ?? '';

    pauseNext = true;
    const deletion = service.deleteSessions([id]);
    await pausedAt;
    const make = service.makeReportCommand(id);
    // Refused: make resolves. (Before: its write passed and waited at the rename.)
    await Promise.race([make, renameReached]);
    resume();
    const outcome = await deletion;
    openRename();
    const result = await make;

    expect(outcome).toMatchObject({ deleted: [id], kept: [] });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
    await expect(fsp.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const left = await fsp.readdir(path.dirname(file)).catch(() => []);
    expect(left).toEqual([]);
    expect(tmp.store.history.session(id)).toBeNull();
    expect((await tmp.store.listSessionRecords()).map((r) => r.sessionId)).toEqual([]);
    expect(tmp.store.history.agentRuns([])).toEqual([]);

    // The mark stays without a new event: the same events stored again but not yet noted get no file.
    openRename();
    await appendAll(tmp.store, events);
    await expect(service.makeReportCommand(id)).resolves.toMatchObject({ ok: false, code: 'not_found' });
    await expect(fsp.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    // A run that comes back (its events noted as stored) can have a report again.
    service.noteStored(events);
    await service.flushReports();
    await expect(service.makeReportCommand(id)).resolves.toEqual({ ok: true, detail: file });
    await fsp.access(file);
  });

  it('a session the deletion did not reach (quit) keeps getting reports', async () => {
    const { tmp, service } = await setup();
    const id = 'not-reached';
    await appendAll(tmp.store, fixtureSession('single-agent.jsonl', id, { lastTs: NOW - 40 * DAY }));
    const outcome = await service.deleteSessions([id], () => true);
    expect(outcome).toMatchObject({ deleted: [], kept: [] });
    await expect(service.makeReportCommand(id)).resolves.toEqual({ ok: true, detail: reportPathFor(tmp.dir, id) });
  });

  it('delete all leaves the kept sessions; stray report and temp files of unknown runs go', async () => {
    const { tmp, service } = await setup();
    await appendAll(tmp.store, [
      ...fixtureSession('single-agent.jsonl', 'a', { lastTs: NOW - DAY }),
      ...fixtureSession('single-agent.jsonl', BUDGETS, { lastTs: NOW - DAY }).slice(0, 1),
    ]);
    expect(await service.deleteAllCandidates()).toEqual(['a']);
    const dir = path.join(tmp.dir, 'reports');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'gone.md'), 'x');
    await fsp.writeFile(path.join(dir, '.gone.0123456789ab.tmp'), 'x');
    await fsp.writeFile(path.join(dir, `${BUDGETS}.md`), 'x');
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'x');
    expect(await service.removeReportFiles(new Set([BUDGETS]))).toBe(2);
    expect((await fsp.readdir(dir)).sort()).toEqual([`${BUDGETS}.md`, 'notes.txt']);
  });
});
