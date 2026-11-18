/**
 * hookFacts over recorded payloads: the tool call key that ties a PermissionRequest (no tool_use_id) to the PostToolUse
 * of the same call, and the turn and session ends the broker reads (SPIKES S1, 2026-11-14 note).
 */
import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { parseHookPayload, type ParseHookResult } from '../ingest/schemas.js';
import { readFixture } from '../test/fixtures.js';
import { hookFacts, type HookFacts, type ToolCallKey } from './hook-facts.js';
import { normalizeHook } from './hooks.js';

type Accepted = Extract<ParseHookResult, { ok: true }>;

function parsed(payload: unknown): Accepted {
  const result = parseHookPayload(payload);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function hooks(name: string): { event: string; facts: HookFacts; events: HuddleEvent[]; payload: unknown }[] {
  let n = 0;
  return readFixture(name)
    .filter((l) => l.kind === 'hook')
    .map((l) => {
      const p = parsed(l.payload);
      return {
        event: l.event ?? '',
        facts: hookFacts(p),
        events: normalizeHook(p, { receivedAt: l.t, nextId: () => `e-${String((n += 1))}` }),
        payload: l.payload,
      };
    });
}

function callOf(facts: HookFacts): ToolCallKey {
  if (facts.kind !== 'permission_request' && facts.kind !== 'tool_ended') throw new Error(`no call on ${facts.kind}`);
  return facts.call;
}

describe('hookFacts tool call key (fixtures)', () => {
  it('permission-allow: PermissionRequest and PostToolUse of one call have the same key, digest = tool.started', () => {
    const lines = hooks('permission-allow.jsonl');
    const pre = lines.find((l) => l.event === 'PreToolUse');
    const request = lines.find((l) => l.event === 'PermissionRequest');
    const post = lines.find((l) => l.event === 'PostToolUse');
    if (pre === undefined || request === undefined || post === undefined) throw new Error('fixture changed');
    const started = pre.events.find((e) => e.type === 'tool.started');
    if (started?.type !== 'tool.started') throw new Error('no tool.started');
    expect(request.facts).toMatchObject({ kind: 'permission_request', askUserQuestion: false });
    expect(callOf(request.facts)).toEqual(callOf(post.facts));
    expect(callOf(request.facts)).toEqual({
      toolName: 'Bash',
      digest: started.inputDigest,
      summary: 'npm view zod version',
    });
    expect(post.facts).toMatchObject({ kind: 'tool_ended', agentKey: agentKey('session-1') });
  });

  it('failure: PostToolUseFailure is a tool end with the key of its call', () => {
    const lines = hooks('failure.jsonl');
    const failed = lines.find((l) => l.event === 'PostToolUseFailure');
    expect(failed?.facts).toMatchObject({ kind: 'tool_ended', call: { toolName: 'Read' } });
  });

  it('parallel-subagents: a subagent request differs from that subagent later, unrelated calls', () => {
    const lines = hooks('parallel-subagents.jsonl');
    const request = lines.find((l) => l.event === 'PermissionRequest');
    if (request === undefined) throw new Error('fixture changed');
    const key = callOf(request.facts);
    expect(request.facts).toMatchObject({ agentKey: agentKey('session-1', 'agent-1') });
    const later = lines.filter(
      (l) => l.facts.kind === 'tool_ended' && l.facts.agentKey === agentKey('session-1', 'agent-1'),
    );
    expect(later.length).toBeGreaterThan(3);
    for (const l of later) expect(callOf(l.facts)).not.toEqual(key);
  });

  it('interactive-helpers: SubagentStop and UserPromptSubmit are turn ends, SessionEnd a session end', () => {
    const lines = hooks('interactive-helpers.jsonl');
    expect(lines.find((l) => l.event === 'UserPromptSubmit')?.facts).toEqual({
      kind: 'turn_over',
      sessionId: 'session-1',
      agentKey: agentKey('session-1'),
    });
    expect(lines.find((l) => l.event === 'SubagentStop')?.facts.kind).toBe('turn_over');
    expect(lines.find((l) => l.event === 'SessionEnd')?.facts).toEqual({
      kind: 'session_over',
      sessionId: 'session-1',
    });
  });

  it('a SubagentStop with an empty agent_id is not a turn end of the main agent (A1-02)', () => {
    const facts = hookFacts(
      parsed({ session_id: 'session-1', hook_event_name: 'SubagentStop', agent_id: '', agent_type: 'x' }),
    );
    expect(facts).toEqual({ kind: 'other' });
  });

  it('a PermissionRequest for AskUserQuestion is flagged (input from the recorded AskUserQuestion call)', () => {
    const request = hooks('permission-allow.jsonl').find((l) => l.event === 'PermissionRequest');
    const ask = hooks('interactive-helpers.jsonl').find((l) => l.event === 'PreToolUse');
    if (request === undefined || ask === undefined) throw new Error('fixture changed');
    const askInput = (ask.payload as { tool_input: unknown }).tool_input;
    const payload = { ...(request.payload as object), tool_name: 'AskUserQuestion', tool_input: askInput };
    const facts = hookFacts(parsed(payload));
    expect(facts).toMatchObject({ kind: 'permission_request', askUserQuestion: true });
  });

  it('a call whose summary is only the tool name has no summary (it must match by digest)', () => {
    const facts = hookFacts(
      parsed({
        session_id: 's',
        transcript_path: 't',
        cwd: 'c',
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__srv__do',
        tool_input: { a: 1 },
        tool_use_id: 'tu',
      }),
    );
    expect(callOf(facts).summary).toBeNull();
  });
});
