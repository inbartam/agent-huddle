import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { builder } from '../test/report-events.js';
import { ASK_GUARD_HOLD_MAX, AskGuard } from './ask-guard.js';

const FOLDER = 'C:\\Users\\u\\AppData\\Local\\Temp\\huddle-ask-abc123';

function events() {
  const ev = builder();
  const started = (sessionId: string, cwd: string | null): HuddleEvent =>
    ev('session.started', agentKey(sessionId), {
      origin: 'attached',
      cwd,
      title: null,
      model: null,
      startKind: 'startup',
    });
  const usage = (sessionId: string): HuddleEvent =>
    ev(
      'usage.recorded',
      agentKey(sessionId),
      {
        model: 'claude-haiku-5-5',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        requestId: null,
        durationMs: null,
        querySource: null,
      } as never,
      { source: 'telemetry' },
    );
  return { started, usage };
}

describe('AskGuard', () => {
  it('drops hook events of a session that started in an ask folder, then and later', () => {
    const g = new AskGuard('win32');
    const { started, usage } = events();
    g.begin(FOLDER);
    expect(g.admitHook([started('ask-1', 'c:/users/u/appdata/local/temp/huddle-ask-abc123')])).toEqual([]);
    expect(g.isAskSession('ask-1')).toBe(true);
    expect(g.admitHook([started('ask-2', `${FOLDER}\\sub`)])).toEqual([]);
    const real = started('real', 'C:\\p');
    expect(g.admitHook([real])).toEqual([real]);
    g.end(null, () => true);
    expect(g.admitHook([usage('ask-1')])).toEqual([]);
    expect(g.admitOther([usage('ask-1')], () => true)).toEqual([]);
    expect(g.droppedCount).toBe(4);
  });

  it('holds telemetry of unknown sessions while an ask runs; drops the ask session and releases the rest at the end', () => {
    const g = new AskGuard('win32');
    const { usage } = events();
    const known = new Set(['live']);
    const isKnown = (id: string) => known.has(id);
    const liveUsage = usage('live');
    expect(g.admitOther([liveUsage], isKnown)).toEqual([liveUsage]);
    g.begin(FOLDER);
    const a = usage('ask-session');
    const b = usage('other');
    const c = usage('other');
    expect(g.admitOther([a, b, liveUsage], isKnown)).toEqual([liveUsage]);
    expect(g.admitOther([c], isKnown)).toEqual([]);
    expect(g.end('ask-session', isKnown)).toEqual([b, c]);
    // After the ask: the ask session is dropped, others pass at once.
    expect(g.admitOther([usage('ask-session')], isKnown)).toEqual([]);
    const d = usage('new');
    expect(g.admitOther([d], isKnown)).toEqual([d]);
  });

  it('an ask that ended without a session id releases only sessions the state knows by then', () => {
    const g = new AskGuard('win32');
    const { usage } = events();
    g.begin(FOLDER);
    const x = usage('x');
    const y = usage('y');
    expect(g.admitOther([x, y], () => false)).toEqual([]);
    expect(g.end(null, (id) => id === 'y')).toEqual([y]);
    expect(g.droppedCount).toBe(1);
  });

  it('never holds more than ASK_GUARD_HOLD_MAX events (the oldest are released)', () => {
    const g = new AskGuard('win32');
    const { usage } = events();
    g.begin(FOLDER);
    const many = Array.from({ length: ASK_GUARD_HOLD_MAX + 3 }, () => usage('u'));
    expect(g.admitOther(many, () => false)).toEqual(many.slice(0, 3));
  });

  it('passes everything through when no ask ran', () => {
    const g = new AskGuard('win32');
    const { started, usage } = events();
    const list = [started('s', 'C:/p'), usage('t')];
    expect(g.admitHook(list)).toEqual(list);
    expect(g.admitOther(list, () => false)).toEqual(list);
  });
});
