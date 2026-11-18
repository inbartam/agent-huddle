import { describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { runResultSchema } from '../contracts/m4-schemas.js';
import { MAX_STREAM_LINE_CHARS, oversizedLineIsResult, parseStreamLine } from '../ingest/stream-schema.js';
import { listStreamFixtureFiles, readFixture } from '../test/fixtures.js';
import { normalizeStreamLine, normalizeStreamMessage, type StreamContext } from './stream.js';

const SESSION = '00000000-0000-4000-8000-0000000000a2';
const SECRET = 'SECRET-TEXT-must-never-be-stored';

function ctx(receivedAt = 1_794_659_000_000): StreamContext {
  let n = 0;
  return { runId: 'run-1', sessionId: SESSION, receivedAt, nextId: () => `id-${String(++n)}` };
}

const line = (value: unknown) => JSON.stringify(value);

/** Shapes from S8 and S16, with text replaced by SECRET so the tests can prove it is not copied. */
const INIT = {
  type: 'system',
  subtype: 'init',
  cwd: 'C:/Users/user/project',
  session_id: SESSION,
  tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read'],
  mcp_servers: [],
  model: 'claude-sonnet-5-5',
  permissionMode: 'default',
  slash_commands: [],
  apiKeySource: 'none',
  claude_code_version: '2.1.325',
  agents: ['general-purpose', 's16-lister'],
  capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
  memory_paths: { project: SECRET },
  uuid: '00000000-0000-4000-8000-000000000001',
};
const ASSISTANT_MAIN = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: SECRET },
      { type: 'text', text: SECRET },
      { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { prompt: SECRET, subagent_type: 's16-lister' } },
    ],
  },
  parent_tool_use_id: null,
  session_id: SESSION,
};
const USER_SUB = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_glob', content: SECRET }] },
  parent_tool_use_id: 'toolu_agent',
  agent_id: 'a4038c21d747c68e4',
  session_id: SESSION,
  tool_use_result: { stdout: SECRET },
};
const RESULT_OK = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 22938,
  num_turns: 4,
  result: SECRET,
  stop_reason: 'end_turn',
  total_cost_usd: 0.2884,
  permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_x', tool_input: { command: SECRET } }],
  session_id: SESSION,
};
const RESULT_INTERRUPTED = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 6291,
  num_turns: 3,
  total_cost_usd: 0.253912,
  stop_reason: 'tool_use',
  permission_denials: [],
  errors: [SECRET],
  session_id: SESSION,
};
const RATE_LIMIT = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1794772800,
    rateLimitType: 'seven_day',
    unifiedWindows: { seven_day: { utilization: 0.67, resetsAt: 1794772800, status: 'allowed' } },
  },
  session_id: SESSION,
};
const CONTROL_OK = {
  type: 'control_response',
  response: { subtype: 'success', request_id: 'huddle-int-1', response: { still_queued: [], cancelled: [] } },
};

describe('parseStreamLine', () => {
  it('reads system/init facts: capabilities array, model, mode, tool count, agents', () => {
    expect(parseStreamLine(line(INIT))).toEqual({
      kind: 'init',
      sessionId: SESSION,
      model: 'claude-sonnet-5-5',
      permissionMode: 'default',
      claudeCodeVersion: '2.1.325',
      cwd: 'C:/Users/user/project',
      capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
      toolCount: 5,
      agents: ['general-purpose', 's16-lister'],
    });
  });

  it('keeps only names that look like capabilities, and tolerates a wrong type', () => {
    const odd = parseStreamLine(line({ ...INIT, capabilities: ['ok_v1', { name: 'named_v2' }, 7, 'has space'] }));
    expect(odd).toMatchObject({ kind: 'init', capabilities: ['ok_v1', 'named_v2'] });
    const wrong = parseStreamLine(line({ ...INIT, capabilities: 'interrupt_cancel_queued_v1', tools: 3, model: 5 }));
    expect(wrong).toMatchObject({ kind: 'init', capabilities: [], toolCount: null, model: null });
  });

  it('reads assistant and user messages as role plus parent_tool_use_id only', () => {
    expect(parseStreamLine(line(ASSISTANT_MAIN))).toEqual({
      kind: 'message',
      role: 'assistant',
      parentToolUseId: null,
    });
    expect(parseStreamLine(line(USER_SUB))).toEqual({ kind: 'message', role: 'user', parentToolUseId: 'toolu_agent' });
  });

  it('reads result success and error_during_execution', () => {
    expect(parseStreamLine(line(RESULT_OK))).toEqual({
      kind: 'result',
      subtype: 'success',
      isError: false,
      durationMs: 22938,
      numTurns: 4,
      totalCostUsd: 0.2884,
      permissionDenials: 1,
      sessionId: SESSION,
    });
    expect(parseStreamLine(line(RESULT_INTERRUPTED))).toMatchObject({
      kind: 'result',
      subtype: 'error_during_execution',
      isError: true,
      permissionDenials: 0,
    });
  });

  it('reads rate_limit_event windows', () => {
    expect(parseStreamLine(line(RATE_LIMIT))).toEqual({
      kind: 'rate_limit',
      fiveHour: null,
      sevenDay: { utilization: 0.67, resetsAt: 1794772800 },
    });
  });

  it('reads control_response success and error', () => {
    expect(parseStreamLine(line(CONTROL_OK))).toEqual({
      kind: 'control_response',
      requestId: 'huddle-int-1',
      subtype: 'success',
      error: null,
    });
    const err = parseStreamLine(
      line({ type: 'control_response', response: { subtype: 'error', request_id: 'r2', error: 'x'.repeat(5000) } }),
    );
    expect(err).toMatchObject({ kind: 'control_response', subtype: 'error', requestId: 'r2' });
    expect(err?.kind === 'control_response' ? err.error?.length : 0).toBe(1000);
  });

  it('reads other system subtypes as system with the subtype only', () => {
    expect(parseStreamLine(line({ type: 'system', subtype: 'task_started', prompt: SECRET }))).toEqual({
      kind: 'system',
      subtype: 'task_started',
    });
  });

  it('returns null for an unknown type, malformed JSON, a non-object, a huge line, and never throws', () => {
    expect(parseStreamLine(line({ type: 'stream_event', event: {} }))).toBeNull();
    expect(parseStreamLine(line({ type: 'control_request', request_id: 'x', request: {} }))).toBeNull();
    expect(parseStreamLine(line({ no: 'type' }))).toBeNull();
    expect(parseStreamLine('{"type":"result",')).toBeNull();
    expect(parseStreamLine('not json')).toBeNull();
    expect(parseStreamLine('[1,2]')).toBeNull();
    expect(parseStreamLine('null')).toBeNull();
    expect(parseStreamLine('')).toBeNull();
    const huge = line({ type: 'result', subtype: 'success', result: 'x'.repeat(MAX_STREAM_LINE_CHARS) });
    expect(parseStreamLine(huge)).toBeNull();
    expect(oversizedLineIsResult(huge.slice(0, 256))).toBe(true);
    expect(oversizedLineIsResult(line({ type: 'user', message: {} }))).toBe(false);
  });
});

describe('normalizeStreamMessage', () => {
  it('turns a result into run.result on the session root, source stream', () => {
    const events = normalizeStreamLine(line(RESULT_OK), ctx())?.events ?? [];
    expect(events).toEqual([
      {
        id: 'id-1',
        type: 'run.result',
        ts: 1_794_659_000_000,
        sessionId: SESSION,
        agentKey: agentKey(SESSION),
        source: 'stream',
        runId: 'run-1',
        isError: false,
        durationMs: 22938,
        numTurns: 4,
        totalCostUsd: 0.2884,
        permissionDenials: 1,
      },
    ]);
    expect(runResultSchema.safeParse(events[0]).success).toBe(true);
  });

  it('marks an interrupted turn as an error; falls back on subtype when is_error is missing', () => {
    expect(normalizeStreamLine(line(RESULT_INTERRUPTED), ctx())?.events[0]).toMatchObject({ isError: true });
    const { is_error: _drop, ...noFlag } = RESULT_INTERRUPTED;
    expect(normalizeStreamLine(line(noFlag), ctx())?.events[0]).toMatchObject({ isError: true });
    const bare = normalizeStreamLine(line({ type: 'result', subtype: 'success' }), ctx())?.events[0];
    expect(bare).toMatchObject({
      isError: false,
      durationMs: null,
      numTurns: null,
      totalCostUsd: null,
      permissionDenials: 0,
    });
  });

  it('turns rate_limit_event into limits.measured: utilization as a fraction, resetsAt seconds to ms', () => {
    const events = normalizeStreamLine(line(RATE_LIMIT), ctx(5000))?.events ?? [];
    expect(events).toEqual([
      {
        id: 'id-1',
        type: 'limits.measured',
        ts: 5000,
        sessionId: SESSION,
        agentKey: agentKey(SESSION),
        source: 'stream',
        limits: {
          fiveHourUsedPct: null,
          fiveHourResetsAt: null,
          sevenDayUsedPct: 67,
          sevenDayResetsAt: 1794772800000,
          measuredAt: 5000,
        },
      },
    ]);
  });

  it('emits nothing for a rate_limit_event without windows', () => {
    const msg = parseStreamLine(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }));
    expect(msg).not.toBeNull();
    if (msg !== null) expect(normalizeStreamMessage(msg, ctx())).toEqual([]);
  });

  it('emits no tool, usage or model events: init, messages, system and control lines make none', () => {
    for (const raw of [INIT, ASSISTANT_MAIN, USER_SUB, CONTROL_OK, { type: 'system', subtype: 'hook_started' }]) {
      expect(normalizeStreamLine(line(raw), ctx())?.events).toEqual([]);
    }
  });

  it('never copies message text, thinking, tool input, tool results or the answer', () => {
    const all = [INIT, ASSISTANT_MAIN, USER_SUB, RESULT_OK, RESULT_INTERRUPTED, RATE_LIMIT, CONTROL_OK].map((raw) =>
      normalizeStreamLine(line(raw), ctx()),
    );
    expect(JSON.stringify(all)).not.toContain(SECRET);
  });
});

describe('stream fixtures replay through the normalizer', () => {
  const files = listStreamFixtureFiles();

  it('has the S16 team and interrupt fixtures', () => {
    expect(files).toEqual(expect.arrayContaining(['stream-s16-team.jsonl', 'stream-s16-interrupt.jsonl']));
  });

  function replay(name: string) {
    const c = ctx();
    const messages = [];
    const events: HuddleEvent[] = [];
    let unread = 0;
    for (const fixtureLine of readFixture(name)) {
      expect(fixtureLine.kind).toBe('stream');
      const out = normalizeStreamLine(JSON.stringify(fixtureLine.payload), c);
      if (out === null) {
        unread += 1;
        continue;
      }
      messages.push(out.message);
      events.push(...out.events);
    }
    return { messages, events, unread };
  }

  it('stream-s16-team.jsonl: one init, subagent messages tied to Agent calls, one result, one limits reading', () => {
    const { messages, events, unread } = replay('stream-s16-team.jsonl');
    expect(unread).toBe(0);
    const inits = messages.filter((m) => m.kind === 'init');
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({
      sessionId: SESSION,
      permissionMode: 'default',
      capabilities: expect.arrayContaining(['interrupt_cancel_queued_v1']) as unknown,
      agents: expect.arrayContaining(['s16-lister', 's16-reader', 's16-grepper']) as unknown,
    });
    const parents = new Set(
      messages.flatMap((m) => (m.kind === 'message' && m.parentToolUseId !== null ? [m.parentToolUseId] : [])),
    );
    // S16 d: 9 subagent messages, 3 distinct parent ids, each an Agent tool_use id of the main loop.
    expect(messages.filter((m) => m.kind === 'message' && m.parentToolUseId !== null)).toHaveLength(9);
    expect(parents.size).toBe(3);
    expect(events.map((e) => e.type)).toEqual(['limits.measured', 'run.result']);
    expect(events[1]).toMatchObject({ isError: false, numTurns: 4, permissionDenials: 0, source: 'stream' });
  });

  it('stream-s16-interrupt.jsonl: control_response, an interrupted turn, then a successful one', () => {
    const { messages, events, unread } = replay('stream-s16-interrupt.jsonl');
    expect(unread).toBe(0);
    expect(messages.filter((m) => m.kind === 'init')).toHaveLength(2);
    expect(messages.find((m) => m.kind === 'control_response')).toMatchObject({ subtype: 'success' });
    const results = events.filter((e) => e.type === 'run.result');
    expect(results.map((e) => e.isError)).toEqual([true, false]);
  });

  it('no fixture event carries free text', () => {
    for (const name of files) {
      const { events } = replay(name);
      expect(JSON.stringify(events)).not.toContain('(scrubbed text)');
    }
  });
});
