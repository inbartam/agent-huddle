/**
 * Agent teams (M6 item 3, spike S20): how hook payloads become teammate events. Replays fixtures/agent-team.jsonl, the
 * scrubbed S20 (b) interactive run with two in-process teammates (alpha, beta) and one plain general-purpose subagent.
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { parseHookPayload } from '../ingest/schemas.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { normalizeHook, teammateNameOf } from './hooks.js';

const FIXTURE = 'agent-team.jsonl';
const SID = '00000000-0000-4000-8000-000000000001';
const ALPHA = 'aalpha-0000000000000001';
const BETA = 'abeta-0000000000000002';
const PLAIN = 'a0000000000000003';

function ofType<T extends HuddleEvent['type']>(events: readonly HuddleEvent[], type: T) {
  return events.filter((e): e is Extract<HuddleEvent, { type: T }> => e.type === type);
}

function normalizeOne(body: Record<string, unknown>): HuddleEvent[] {
  const parsed = parseHookPayload({ session_id: SID, ...body });
  if (!parsed.ok) throw new Error(parsed.error);
  let n = 0;
  return normalizeHook(parsed, { receivedAt: '2026-11-16T12:00:00.000Z', nextId: () => `e${String((n += 1))}` });
}

describe('teammateNameOf (the teammate rule)', () => {
  it('accepts a<name>-<16 hex> when agent_type is the name', () => {
    expect(teammateNameOf('aalpha-23fa3cf482744ddd', 'alpha')).toBe('alpha');
    expect(teammateNameOf('abeta-B0996EF526701CC0', 'beta')).toBe('beta');
    expect(teammateNameOf('acode-reviewer-0123456789abcdef', 'code-reviewer')).toBe('code-reviewer');
  });

  it('never calls a plain subagent (a<16 hex>) a teammate, whatever its type', () => {
    const types = ['general-purpose', 'Explore', 'Plan', 'core-engineer', 'a', '0', 'cb13e20170d4bf4b', ''];
    const ids = [
      'acb13e20170d4bf4b',
      'a75c72ca837a097bc',
      'accd8e2f407945d73',
      'a0000000000000003',
      'affffffffffffffff',
    ];
    for (let i = 0; i < 200; i += 1) {
      ids.push(`a${(BigInt(i) * 0x9e3779b97f4a7c15n).toString(16).padStart(16, '0').slice(-16)}`);
    }
    for (const agentId of ids) {
      for (const agentType of [...types, undefined]) expect(teammateNameOf(agentId, agentType), agentId).toBeNull();
    }
  });

  it('needs the id to embed exactly the agent_type and a 16-hex tail', () => {
    expect(teammateNameOf('aalpha-23fa3cf482744ddd', 'beta')).toBeNull();
    expect(teammateNameOf('aalpha-23fa3cf482744ddd', 'alph')).toBeNull();
    expect(teammateNameOf('aalpha-23fa3cf482744dd', 'alpha')).toBeNull();
    expect(teammateNameOf('aalpha-23fa3cf482744dddd', 'alpha')).toBeNull();
    expect(teammateNameOf('aalpha-23fa3cf482744ddg', 'alpha')).toBeNull();
    expect(teammateNameOf('alpha-23fa3cf482744ddd', 'alpha')).toBeNull();
    expect(teammateNameOf('aalpha-23fa3cf482744ddd', '')).toBeNull();
    expect(teammateNameOf('aalpha-23fa3cf482744ddd', undefined)).toBeNull();
  });
});

describe(`normalizeHook over ${FIXTURE}`, () => {
  const events = fixtureEvents(FIXTURE);

  it('marks the two teammates on agent.started and leaves the plain subagent alone', () => {
    const started = ofType(events, 'agent.started');
    expect(started.map((e) => [e.agentId, e.role, e.teammateName])).toEqual([
      [ALPHA, 'alpha', 'alpha'],
      [BETA, 'beta', 'beta'],
      [PLAIN, 'general-purpose', undefined],
    ]);
    const plain = started.find((e) => e.agentId === PLAIN);
    expect(plain !== undefined && 'teammateName' in plain).toBe(false);
  });

  it('turns each TeammateIdle into teammate.idle on the teammate key', () => {
    expect(ofType(events, 'teammate.idle')).toEqual([
      expect.objectContaining({
        agentKey: agentKey(SID, ALPHA),
        agentId: ALPHA,
        teammateName: 'alpha',
        teamName: 'session-00000000',
      }),
      expect.objectContaining({
        agentKey: agentKey(SID, BETA),
        agentId: BETA,
        teammateName: 'beta',
        teamName: 'session-00000000',
      }),
    ]);
  });

  it('keeps the Agent call name on agent.spawn_requested, only when the call had one', () => {
    const spawns = ofType(events, 'agent.spawn_requested');
    expect(spawns.map((e) => e.name)).toEqual(['alpha', 'beta', undefined]);
    expect('name' in (spawns[2] ?? {})).toBe(false);
  });

  it('drops the helper SubagentStops (empty agent_type, no SubagentStart)', () => {
    const helperKeys = [agentKey(SID, 'a0000000000000004'), agentKey(SID, 'a0000000000000005')];
    expect(events.filter((e) => helperKeys.includes(e.agentKey))).toEqual([]);
  });
});

describe('TeammateIdle edge cases', () => {
  it('without agent_id: the root key and agentId null', () => {
    expect(normalizeOne({ hook_event_name: 'TeammateIdle', teammate_name: 'alpha' })).toEqual([
      expect.objectContaining({ type: 'teammate.idle', agentKey: agentKey(SID), agentId: null, teamName: null }),
    ]);
  });

  it('falls back to agent_type for the name, and emits nothing without either', () => {
    expect(
      normalizeOne({ hook_event_name: 'TeammateIdle', agent_id: ALPHA, agent_type: 'alpha' }).map((e) =>
        e.type === 'teammate.idle' ? e.teammateName : null,
      ),
    ).toEqual(['alpha']);
    expect(normalizeOne({ hook_event_name: 'TeammateIdle' })).toEqual([]);
    expect(normalizeOne({ hook_event_name: 'TeammateIdle', teammate_name: '', agent_type: '' })).toEqual([]);
  });

  it('task hooks accept team_name (docs-only fields; TaskCreated/TaskCompleted were not seen in S20)', () => {
    const created = normalizeOne({
      hook_event_name: 'TaskCreated',
      task_id: 't1',
      task_subject: 'x',
      teammate_name: 'alpha',
      team_name: 'session-00000000',
      agent_id: ALPHA,
    });
    expect(created).toEqual([expect.objectContaining({ type: 'task.created', agentKey: agentKey(SID, ALPHA) })]);
  });
});
