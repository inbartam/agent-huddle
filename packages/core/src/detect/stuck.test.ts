import type { HuddleEvent } from '@huddle/shared';
import { describe, expect, it } from 'vitest';
import { emptyDetectorState, step, tick, type DetectorState } from './index.js';
import { initialState, reduce } from '../state/reduce.js';
import { builder, DEFAULTS, MAIN, MIN, raisedIds, resolvedIds, run, SUB, T0 } from '../test/detect-events.js';

function working(ev: ReturnType<typeof builder>): HuddleEvent[] {
  return [
    ev(
      'session.started',
      { ts: T0 },
      { origin: 'attached', cwd: 'C:\\repo', title: null, model: null, startKind: 'startup' },
    ),
    ev('prompt.submitted', { ts: T0 + 1000 }, { text: 'go', promptId: 'p1' }),
  ];
}

function tickAt(state: DetectorState, now: number, thresholds = DEFAULTS) {
  return tick(state, now, thresholds);
}

describe('stuck detector', () => {
  it('raises once after stuckMinutes of silence while working', () => {
    const ev = builder();
    const { state } = run(working(ev));
    expect(tickAt(state, T0 + 1000 + 5 * MIN - 1).emit).toEqual([]);
    const first = tickAt(state, T0 + 1000 + 5 * MIN);
    expect(raisedIds(first.emit)).toEqual([`stuck:${MAIN}`]);
    const raised = first.emit[0];
    expect(raised).toMatchObject({
      type: 'attention.raised',
      ts: T0 + 1000 + 5 * MIN,
      sessionId: 'sess-a',
      agentKey: MAIN,
      source: 'huddle',
      item: { kind: 'stuck', severity: 'warning', agentKey: MAIN, createdAt: T0 + 1000 + 5 * MIN, resolvedAt: null },
    });
    if (raised?.type === 'attention.raised') {
      expect(raised.item.title).toBe('No activity for 5 min');
    }
    // Later ticks while the condition persists: no new item.
    expect(tickAt(first.state, T0 + 20 * MIN).emit).toEqual([]);
  });

  it('is not stuck when idle, waiting on the user, or ended', () => {
    const ev = builder();
    const base = working(ev);
    const idle = run([...base, ev('turn.ended', { ts: T0 + 2000 }, { lastMessage: null, backgroundAgentIds: [] })]);
    expect(tickAt(idle.state, T0 + 60 * MIN).emit).toEqual([]);

    const ev2 = builder();
    const waiting = run([
      ...working(ev2),
      ev2(
        'approval.requested',
        { ts: T0 + 2000 },
        {
          request: {
            requestId: 'r1',
            agentKey: MAIN,
            toolName: 'Bash',
            toolInput: {},
            summary: 'npm test',
            receivedAt: T0 + 2000,
            expiresAt: null,
            channel: 'hook',
          },
        },
      ),
    ]);
    expect(tickAt(waiting.state, T0 + 60 * MIN).emit).toEqual([]);

    const ev3 = builder();
    const ended = run([...working(ev3), ev3('session.ended', { ts: T0 + 2000 }, { reason: 'other' })]);
    expect(tickAt(ended.state, T0 + 60 * MIN).emit).toEqual([]);
  });

  it('main agent idle with background subagents running is not stuck; the subagent is watched', () => {
    const ev = builder();
    const { state } = run([
      ...working(ev),
      ev('agent.started', { ts: T0 + 2000, agent: SUB }, { agentId: 'sub1', role: 'general-purpose', parentKey: MAIN }),
      ev('turn.ended', { ts: T0 + 3000 }, { lastMessage: null, backgroundAgentIds: ['sub1'] }),
    ]);
    expect(raisedIds(tickAt(state, T0 + 2000 + 5 * MIN).emit)).toEqual([`stuck:${SUB}`]);
  });

  it('uses stuckOpenToolMinutes while a tool call is open', () => {
    const ev = builder();
    const { state } = run([
      ...working(ev),
      ev(
        'tool.started',
        { ts: T0 + 2000 },
        { toolUseId: 't1', toolName: 'Bash', summary: 'npm test', filePath: null, inputDigest: 'd1' },
      ),
    ]);
    expect(tickAt(state, T0 + 2000 + 14 * MIN).emit).toEqual([]);
    const out = tickAt(state, T0 + 2000 + 15 * MIN);
    expect(raisedIds(out.emit)).toEqual([`stuck:${MAIN}`]);
    const raised = out.emit[0];
    if (raised?.type === 'attention.raised') expect(raised.item.detail).toContain('Bash: npm test');
  });

  it('a foreground subagent keeps its waiting parent from being stuck', () => {
    const ev = builder();
    const events: HuddleEvent[] = [
      ...working(ev),
      ev(
        'tool.started',
        { ts: T0 + 2000 },
        { toolUseId: 'a1', toolName: 'Agent', summary: 'Explore', filePath: null, inputDigest: 'dA' },
      ),
      ev('agent.started', { ts: T0 + 3000, agent: SUB }, { agentId: 'sub1', role: 'Explore', parentKey: MAIN }),
    ];
    // The subagent keeps reporting every 4 minutes for 40 minutes.
    for (let i = 1; i <= 10; i++) {
      events.push(
        ev(
          'tool.started',
          { ts: T0 + 3000 + i * 4 * MIN, agent: SUB },
          {
            toolUseId: `s${String(i)}`,
            toolName: 'Read',
            summary: `f${String(i)}`,
            filePath: null,
            inputDigest: `r${String(i)}`,
          },
        ),
        ev(
          'tool.finished',
          { ts: T0 + 3000 + i * 4 * MIN + 10, agent: SUB },
          { toolUseId: `s${String(i)}`, toolName: 'Read', durationMs: 10 },
        ),
      );
    }
    const out = run(events, DEFAULTS, { tickAtEachEvent: true });
    expect(raisedIds(out.emitted)).toEqual([]);
    // When the whole session goes quiet past the open-tool threshold, the parent is flagged too.
    const lastTs = T0 + 3000 + 40 * MIN + 10;
    expect(raisedIds(tickAt(out.state, lastTs + 15 * MIN).emit).sort()).toEqual([`stuck:${MAIN}`, `stuck:${SUB}`]);
  });

  it('resolves at the next sign of life, and when the agent goes idle or ends', () => {
    const ev = builder();
    const { state } = run(working(ev));
    const raised = tickAt(state, T0 + 10 * MIN);
    // Telemetry for the agent counts as a sign of life.
    const usage = ev(
      'usage.recorded',
      { ts: T0 + 11 * MIN, source: 'telemetry' },
      {
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        requestId: 'q1',
      },
    );
    const live = step(raised.state, usage, DEFAULTS);
    expect(resolvedIds(live.emit)).toEqual([`stuck:${MAIN}`]);
    expect(live.emit[0]).toMatchObject({
      type: 'attention.resolved',
      ts: T0 + 11 * MIN,
      agentKey: MAIN,
      source: 'huddle',
    });

    const ended = step(raised.state, ev('session.ended', { ts: T0 + 11 * MIN }, { reason: 'other' }), DEFAULTS);
    expect(resolvedIds(ended.emit)).toEqual([`stuck:${MAIN}`]);

    const idle = step(
      raised.state,
      ev('turn.ended', { ts: T0 + 11 * MIN }, { lastMessage: null, backgroundAgentIds: [] }),
      DEFAULTS,
    );
    expect(resolvedIds(idle.emit)).toEqual([`stuck:${MAIN}`]);
  });

  it("the Huddle's own and the user's events are not signs of life", () => {
    const ev = builder();
    const { state } = run(working(ev));
    const raised = tickAt(state, T0 + 10 * MIN);
    const queued = step(
      raised.state,
      ev('message.queued', { ts: T0 + 11 * MIN, source: 'user' }, { messageId: 'm1', text: 'hi', delivery: 'auto' }),
      DEFAULTS,
    );
    expect(queued.emit).toEqual([]);
    const own = step(raised.state, raised.emit[0] as HuddleEvent, DEFAULTS);
    expect(own).toEqual({ state: raised.state, emit: [] });
  });

  it('after a resolve, a new silence raises a new episode with a different event id', () => {
    const ev = builder();
    const { state } = run(working(ev));
    const first = tickAt(state, T0 + 10 * MIN);
    const live = step(
      first.state,
      ev(
        'tool.started',
        { ts: T0 + 11 * MIN },
        { toolUseId: null, toolName: 'Glob', summary: '*', filePath: null, inputDigest: 'g' },
      ),
      DEFAULTS,
    );
    const finished = step(
      live.state,
      ev('tool.finished', { ts: T0 + 11 * MIN + 5 }, { toolUseId: null, toolName: 'Glob', durationMs: 5 }),
      DEFAULTS,
    );
    const second = tickAt(finished.state, T0 + 17 * MIN);
    expect(raisedIds(second.emit)).toEqual([`stuck:${MAIN}`]);
    expect(second.emit[0]?.id).not.toBe(first.emit[0]?.id);
  });

  it('honors changed thresholds', () => {
    const ev = builder();
    const { state } = run(working(ev));
    const fast = { ...DEFAULTS, stuckMinutes: 1 };
    expect(raisedIds(tickAt(state, T0 + 1000 + MIN, fast).emit)).toEqual([`stuck:${MAIN}`]);
    const slow = { ...DEFAULTS, stuckMinutes: 30 };
    expect(tickAt(state, T0 + 1000 + 29 * MIN, slow).emit).toEqual([]);
  });

  it('is deterministic: same input, same output', () => {
    const make = () => {
      const ev = builder();
      const r = run(working(ev));
      return tickAt(r.state, T0 + 10 * MIN);
    };
    expect(make()).toEqual(make());
  });

  it('a late tool.finished after the turn ended does not wake the agent', () => {
    const ev = builder();
    const { state } = run([
      ...working(ev),
      ev('turn.ended', { ts: T0 + 2000 }, { lastMessage: null, backgroundAgentIds: [] }),
      ev('tool.finished', { ts: T0 + 3000 }, { toolUseId: 'x', toolName: 'Bash', durationMs: 1 }),
    ]);
    expect(tickAt(state, T0 + 60 * MIN).emit).toEqual([]);
  });

  it('an empty state ticks to nothing', () => {
    expect(tick(emptyDetectorState(), T0, DEFAULTS).emit).toEqual([]);
  });
});

describe('stuck detector and a dismiss (M4 runbook fix)', () => {
  it('a dismissed stuck item stays hidden while the agent stays silent, and comes back for the next episode', () => {
    const ev = builder();
    const events = working(ev);
    let det = run(events).state;
    let huddle = events.reduce((s, e) => reduce(s, e), initialState());
    const id = `stuck:${MAIN}`;

    const first = tickAt(det, T0 + 1000 + 5 * MIN);
    det = first.state;
    huddle = first.emit.reduce((s, e) => reduce(s, e), huddle);
    const dismiss = ev('attention.resolved', { ts: T0 + 6 * MIN, source: 'user' }, { itemId: id, reason: 'dismissed' });
    huddle = reduce(huddle, dismiss);
    // Attention events change nothing in the detectors.
    expect(step(det, dismiss, DEFAULTS).emit).toEqual([]);
    expect(huddle.inbox.find((i) => i.id === id)).toMatchObject({ dismissed: true });

    // Still silent: no new raise.
    expect(tickAt(det, T0 + 30 * MIN).emit).toEqual([]);

    // Life returns: the detector resolves (a no-op for the already dismissed item).
    const life = ev(
      'tool.started',
      { ts: T0 + 31 * MIN },
      { toolUseId: 't1', toolName: 'Read', inputDigest: 'd1', summary: 'x', filePath: null },
    );
    const back = step(det, life, DEFAULTS);
    det = back.state;
    expect(resolvedIds(back.emit)).toEqual([id]);
    huddle = [life, ...back.emit].reduce((s, e) => reduce(s, e), huddle);
    expect(huddle.inbox.filter((i) => i.id === id && i.resolvedAt === null)).toEqual([]);

    // Silent again past the threshold: a new episode, open again.
    const again = tickAt(det, T0 + 31 * MIN + 30 * MIN);
    expect(raisedIds(again.emit)).toEqual([id]);
    huddle = again.emit.reduce((s, e) => reduce(s, e), huddle);
    expect(huddle.inbox.find((i) => i.id === id)).toMatchObject({ resolvedAt: null });
    expect(huddle.inbox.find((i) => i.id === id)?.dismissed).toBeUndefined();
  });
});
