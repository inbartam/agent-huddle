import { agentKey } from '@huddle/shared';
import type { HuddleEvent } from '@huddle/shared';
import { describe, expect, it } from 'vitest';
import { normalizePath, tick } from './index.js';
import { builder, DEFAULTS, MAIN, MIN, raisedIds, resolvedIds, run, SUB, SUB2, T0 } from '../test/detect-events.js';

type Ev = ReturnType<typeof builder>;
const CWD = 'C:\\Repo';
const FILE = 'C:\\Repo\\src\\app.ts';
const ITEM = 'conflict:c:/repo:c:/repo/src/app.ts';
const OTHER_SESSION = 'sess-b';
const OTHER_MAIN = agentKey(OTHER_SESSION);

function setup(ev: Ev): HuddleEvent[] {
  return [
    ev('session.started', { ts: T0 }, { origin: 'attached', cwd: CWD, title: null, model: null, startKind: 'startup' }),
    ev('prompt.submitted', { ts: T0 + 1 }, { text: 'go', promptId: 'p1' }),
    ev('agent.started', { ts: T0 + 2, agent: SUB }, { agentId: 'sub1', role: 'x', parentKey: MAIN }),
    ev('agent.started', { ts: T0 + 3, agent: SUB2 }, { agentId: 'sub2', role: 'y', parentKey: MAIN }),
  ];
}

let seq = 0;
function edit(
  ev: Ev,
  ts: number,
  agent: string,
  opts: { tool?: string; path?: string; session?: string; fail?: boolean } = {},
) {
  seq += 1;
  const id = `e${String(seq)}`;
  const toolName = opts.tool ?? 'Edit';
  const at = { ts, agent, ...(opts.session !== undefined ? { session: opts.session } : {}) };
  return [
    ev('tool.started', at, {
      toolUseId: id,
      toolName,
      summary: opts.path ?? FILE,
      filePath: opts.path ?? FILE,
      inputDigest: id,
    }),
    opts.fail === true
      ? ev('tool.failed', { ...at, ts: ts + 1 }, { toolUseId: id, toolName, error: 'denied', interrupted: false })
      : ev('tool.finished', { ...at, ts: ts + 1 }, { toolUseId: id, toolName, durationMs: 1 }),
  ];
}

describe('file conflict detector', () => {
  it('raises once when two running agents edit the same file within the window', () => {
    const ev = builder();
    const out = run([
      ...setup(ev),
      ...edit(ev, T0 + MIN, SUB),
      ...edit(ev, T0 + 3 * MIN, SUB2),
      ...edit(ev, T0 + 4 * MIN, SUB),
    ]);
    expect(raisedIds(out.emitted)).toEqual([ITEM]);
    expect(out.emitted[0]).toMatchObject({
      type: 'attention.raised',
      agentKey: SUB2,
      source: 'huddle',
      item: { kind: 'file_conflict', title: '2 agents edited app.ts', relatedAgentKeys: [SUB, SUB2], resolvedAt: null },
    });
  });

  it('works across sessions sharing a cwd (case and slashes do not matter on Windows)', () => {
    const ev = builder();
    const out = run([
      ...setup(ev),
      ev(
        'session.started',
        { ts: T0, session: OTHER_SESSION },
        { origin: 'attached', cwd: 'c:/repo/', title: null, model: null, startKind: 'startup' },
      ),
      ev('prompt.submitted', { ts: T0 + 1, session: OTHER_SESSION }, { text: 'go', promptId: 'q1' }),
      ...edit(ev, T0 + MIN, MAIN),
      ...edit(ev, T0 + 2 * MIN, OTHER_MAIN, { session: OTHER_SESSION, path: 'c:/repo/SRC/app.ts' }),
    ]);
    expect(raisedIds(out.emitted)).toEqual([ITEM]);
  });

  it('does not raise for one agent, reads, failed edits, edits outside the window, or different cwds', () => {
    const one = builder();
    expect(
      raisedIds(run([...setup(one), ...edit(one, T0 + MIN, SUB), ...edit(one, T0 + 2 * MIN, SUB)]).emitted),
    ).toEqual([]);

    const reads = builder();
    expect(
      raisedIds(
        run([...setup(reads), ...edit(reads, T0 + MIN, SUB), ...edit(reads, T0 + 2 * MIN, SUB2, { tool: 'Read' })])
          .emitted,
      ),
    ).toEqual([]);

    const failed = builder();
    expect(
      raisedIds(
        run([...setup(failed), ...edit(failed, T0 + MIN, SUB), ...edit(failed, T0 + 2 * MIN, SUB2, { fail: true })])
          .emitted,
      ),
    ).toEqual([]);

    const late = builder();
    expect(
      raisedIds(run([...setup(late), ...edit(late, T0 + MIN, SUB), ...edit(late, T0 + 12 * MIN, SUB2)]).emitted),
    ).toEqual([]);

    const cwd = builder();
    expect(
      raisedIds(
        run([
          ...setup(cwd),
          cwd(
            'session.started',
            { ts: T0, session: OTHER_SESSION },
            { origin: 'attached', cwd: 'D:\\other', title: null, model: null, startKind: 'startup' },
          ),
          cwd('prompt.submitted', { ts: T0 + 1, session: OTHER_SESSION }, { text: 'go', promptId: 'q1' }),
          ...edit(cwd, T0 + MIN, MAIN),
          ...edit(cwd, T0 + 2 * MIN, OTHER_MAIN, { session: OTHER_SESSION }),
        ]).emitted,
      ),
    ).toEqual([]);
  });

  it('a handoff is not a conflict: parent edits, hands to a subagent, then fixes up after it finished', () => {
    const ev = builder();
    const out = run([
      ev(
        'session.started',
        { ts: T0 },
        { origin: 'attached', cwd: CWD, title: null, model: null, startKind: 'startup' },
      ),
      ev('prompt.submitted', { ts: T0 + 1 }, { text: 'go', promptId: 'p1' }),
      ...edit(ev, T0 + MIN, MAIN),
      ev(
        'tool.started',
        { ts: T0 + 2 * MIN },
        { toolUseId: 'spawn', toolName: 'Agent', summary: 'x', filePath: null, inputDigest: 'ag' },
      ),
      ev('agent.started', { ts: T0 + 2 * MIN + 1, agent: SUB }, { agentId: 'sub1', role: 'x', parentKey: MAIN }),
      ...edit(ev, T0 + 3 * MIN, SUB),
      ev('agent.stopped', { ts: T0 + 4 * MIN, agent: SUB }, { agentId: 'sub1', result: null }),
      ev('tool.finished', { ts: T0 + 4 * MIN + 1 }, { toolUseId: 'spawn', toolName: 'Agent', durationMs: 1 }),
      ...edit(ev, T0 + 5 * MIN, MAIN),
    ]);
    expect(raisedIds(out.emitted)).toEqual([]);
  });

  it('resolves when the window passes after the last conflicting edit', () => {
    const ev = builder();
    const out = run([
      ...setup(ev),
      ...edit(ev, T0 + MIN, SUB),
      ...edit(ev, T0 + 3 * MIN, SUB2),
      ...edit(ev, T0 + 5 * MIN, SUB),
    ]);
    const last = T0 + 5 * MIN + 1;
    // Ticks also raise stuck items for the silent agents; only the conflict matters here.
    expect(resolvedIds(tick(out.state, last + 10 * MIN - 1, DEFAULTS).emit)).toEqual([]);
    const done = tick(out.state, last + 10 * MIN, DEFAULTS);
    expect(resolvedIds(done.emit)).toEqual([ITEM]);
    const conflictResolve = done.emit.find((e) => e.type === 'attention.resolved');
    expect(conflictResolve).toMatchObject({ type: 'attention.resolved', ts: last + 10 * MIN, source: 'huddle' });
    expect(resolvedIds(tick(done.state, last + 30 * MIN, DEFAULTS).emit)).toEqual([]);
  });

  it('resolves when fewer than two of the agents involved are still running', () => {
    const ev = builder();
    const out = run([
      ...setup(ev),
      ...edit(ev, T0 + MIN, SUB),
      ...edit(ev, T0 + 2 * MIN, SUB2),
      ev('agent.stopped', { ts: T0 + 3 * MIN, agent: SUB }, { agentId: 'sub1', result: null }),
    ]);
    expect(raisedIds(out.emitted)).toEqual([ITEM]);
    expect(resolvedIds(out.emitted)).toEqual([ITEM]);
  });

  it('honors a changed window', () => {
    const ev = builder();
    const events = [...setup(ev), ...edit(ev, T0 + MIN, SUB), ...edit(ev, T0 + 4 * MIN, SUB2)];
    expect(raisedIds(run(events, { ...DEFAULTS, conflictWindowMinutes: 2 }).emitted)).toEqual([]);
    expect(raisedIds(run(events, { ...DEFAULTS, conflictWindowMinutes: 5 }).emitted)).toEqual([ITEM]);
  });

  it('is deterministic: same input, same output', () => {
    const make = () => {
      seq = 0;
      const ev = builder();
      const r = run([...setup(ev), ...edit(ev, T0 + MIN, SUB), ...edit(ev, T0 + 2 * MIN, SUB2)]);
      return { r, t: tick(r.state, T0 + 30 * MIN, DEFAULTS) };
    };
    expect(make()).toEqual(make());
  });

  it('normalizes paths', () => {
    expect(normalizePath('C:\\Repo\\x\\')).toBe('c:/repo/x');
    expect(normalizePath('\\\\Server\\Share\\A')).toBe('//server/share/a');
    expect(normalizePath('/home/Me/x/')).toBe('/home/Me/x');
  });
});
