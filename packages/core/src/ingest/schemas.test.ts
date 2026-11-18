import { describe, expect, it } from 'vitest';
import { INGESTED_HOOK_EVENTS } from '@huddle/shared/hooks';
import { listFixtureFiles, readFixture } from '../test/fixtures.js';
import { parseHookPayload } from './schemas.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const fixtureFiles = listFixtureFiles();

const base = {
  session_id: 'sess-1',
  transcript_path: 'C:/Users/user/project/t.jsonl',
  cwd: 'C:/Users/user/project',
};

describe('parseHookPayload on recorded fixtures', () => {
  it('finds fixture files', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  describe.each(fixtureFiles)('%s', (file) => {
    const hookLines = readFixture(file).filter((line) => line.kind === 'hook');

    it('parses every hook line as a known event', () => {
      for (const [index, line] of hookLines.entries()) {
        const result = parseHookPayload(line.payload);
        if (!result.ok) throw new Error(`hook line ${String(index)} (${String(line.event)}) failed: ${result.error}`);
        expect(result.known).toBe(true);
        expect(result.payload.hook_event_name).toBe(line.event);
      }
    });

    it('never keeps tool_response in the parsed payload', () => {
      for (const line of hookLines) {
        const result = parseHookPayload(line.payload);
        expect(result.ok).toBe(true);
        if (result.ok) expect('tool_response' in result.payload).toBe(false);
      }
    });

    it('returns the agent link for every PostToolUse(Agent) that has an agentId', () => {
      for (const line of hookLines) {
        const raw = line.payload;
        if (!isRecord(raw) || raw.hook_event_name !== 'PostToolUse') continue;
        const result = parseHookPayload(raw);
        if (!result.ok || !result.known) throw new Error('expected a known parse');
        const response = raw.tool_response;
        if (raw.tool_name === 'Agent' && isRecord(response) && typeof response.agentId === 'string') {
          expect(result.agentLink?.agentId).toBe(response.agentId);
          if (typeof response.status === 'string') expect(result.agentLink?.status).toBe(response.status);
          if (typeof response.isAsync === 'boolean') expect(result.agentLink?.isAsync).toBe(response.isAsync);
          if (typeof response.resolvedModel === 'string') {
            expect(result.agentLink?.resolvedModel).toBe(response.resolvedModel);
          }
        } else {
          expect(result.agentLink).toBeUndefined();
        }
      }
    });

    it('does not mutate the input', () => {
      for (const line of hookLines) {
        const before = JSON.stringify(line.payload);
        parseHookPayload(line.payload);
        expect(JSON.stringify(line.payload)).toBe(before);
      }
    });
  });

  it('covers at least one Agent link across all fixtures', () => {
    const links = fixtureFiles
      .flatMap((file) => readFixture(file))
      .filter((line) => line.kind === 'hook')
      .map((line) => parseHookPayload(line.payload))
      .filter((result) => result.ok && result.known && result.agentLink !== undefined);
    expect(links.length).toBeGreaterThan(0);
  });
});

describe('parseHookPayload on hand-made input', () => {
  it('keeps an unknown field', () => {
    const result = parseHookPayload({ ...base, hook_event_name: 'Stop', someFutureField: { nested: [1, 2] } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toMatchObject({ someFutureField: { nested: [1, 2] } });
  });

  it('parses an unknown event name as an unknown event that keeps the base fields', () => {
    const result = parseHookPayload({ ...base, hook_event_name: 'FutureEvent', agent_id: 'a-1', extra: 1 });
    expect(result).toMatchObject({
      ok: true,
      known: false,
      payload: { hook_event_name: 'FutureEvent', session_id: 'sess-1', agent_id: 'a-1', extra: 1 },
    });
  });

  it('accepts a minimal body for every ingested event that has no extra required field', () => {
    const extraRequired: Partial<Record<string, Record<string, string>>> = {
      PreToolUse: { tool_name: 'Read' },
      PostToolUse: { tool_name: 'Read' },
      PostToolUseFailure: { tool_name: 'Read' },
      PermissionRequest: { tool_name: 'Read' },
      PermissionDenied: { tool_name: 'Read' },
      SubagentStart: { agent_id: 'a-1' },
      SubagentStop: { agent_id: 'a-1' },
      TaskCreated: { task_id: 't-1' },
      TaskCompleted: { task_id: 't-1' },
    };
    for (const event of INGESTED_HOOK_EVENTS) {
      const result = parseHookPayload({ session_id: 's', hook_event_name: event, ...extraRequired[event] });
      expect(result, event).toMatchObject({ ok: true, known: true });
    }
  });

  it('fails a known event that lacks its own required field, without echoing the body', () => {
    const result = parseHookPayload({ ...base, hook_event_name: 'PreToolUse', secret: 'TOPSECRET' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('tool_name');
      expect(result.error).not.toContain('TOPSECRET');
    }
  });

  it('drops an optional field with the wrong type instead of rejecting the event', () => {
    const result = parseHookPayload({ ...base, hook_event_name: 'SessionStart', model: 42, source: 'from-the-future' });
    expect(result.ok).toBe(true);
    if (result.ok && result.known && result.payload.hook_event_name === 'SessionStart') {
      expect(result.payload.model).toBeUndefined();
      expect(result.payload.source).toBeUndefined();
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'hello'],
    ['a number', 42],
    ['an array', [{ ...base, hook_event_name: 'Stop' }]],
    ['an object without hook_event_name', { ...base }],
    ['a non-string hook_event_name', { ...base, hook_event_name: 7 }],
    ['an object without session_id', { hook_event_name: 'Stop' }],
    ['an unknown event without session_id', { hook_event_name: 'FutureEvent' }],
  ])('rejects %s with a typed failure and does not throw', (_label, body) => {
    const result = parseHookPayload(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe('string');
  });

  it.each(['huddle-tasks', 'huddle-budgets', 'huddle-history', 'huddle-phone'])(
    'rejects the Huddle own session id %s at ingest (A1-05)',
    (sessionId) => {
      const result = parseHookPayload({ hook_event_name: 'Stop', session_id: sessionId });
      expect(result.ok).toBe(false);
    },
  );

  it.each([
    ['an empty session_id', ''],
    ['a path-like session_id', '../x'],
    ['a session_id with a slash', 'a/b'],
    ['a Windows device name', 'con'],
    ['an over-long session_id', 's'.repeat(129)],
    ['a multi-MB session_id', 'x'.repeat(2 * 1024 * 1024)],
  ])('rejects %s, known or unknown event, with the store rule (isValidSessionId)', (_label, sessionId) => {
    for (const hook_event_name of ['Stop', 'PermissionRequest', 'FutureEvent']) {
      const result = parseHookPayload({ hook_event_name, session_id: sessionId, tool_name: 'Bash' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('session_id');
        expect(result.error.length).toBeLessThan(500);
      }
    }
  });

  it('accepts a UUID session_id and one of 128 characters', () => {
    for (const sessionId of ['6f1c2d9e-8a3b-4c5d-9e0f-1a2b3c4d5e6f', 's'.repeat(128)]) {
      expect(parseHookPayload({ hook_event_name: 'Stop', session_id: sessionId }).ok).toBe(true);
    }
  });

  it('never echoes body values in the error', () => {
    const result = parseHookPayload({ hook_event_name: 'SuperSecretEventName', session_id: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('SuperSecret');
  });

  it('ignores Agent link fields with the wrong type', () => {
    const result = parseHookPayload({
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_response: { agentId: 'agent-9', isAsync: 'yes', status: 3, resolvedModel: null },
    });
    expect(result).toMatchObject({ ok: true, known: true, agentLink: { agentId: 'agent-9' } });
    if (result.ok && result.known) expect(result.agentLink).toEqual({ agentId: 'agent-9' });
  });

  it('gives no agent link when the Agent tool_response has no string agentId', () => {
    const result = parseHookPayload({
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_response: { agentId: 5, status: 'completed' },
    });
    expect(result).toMatchObject({ ok: true, known: true });
    if (result.ok && result.known) expect(result.agentLink).toBeUndefined();
  });

  it('gives no agent link for a non-Agent tool even if its response has an agentId', () => {
    const result = parseHookPayload({
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_response: { agentId: 'agent-9' },
    });
    expect(result).toMatchObject({ ok: true, known: true });
    if (result.ok && result.known) expect(result.agentLink).toBeUndefined();
  });

  it('drops tool_response on every event, not only PostToolUse', () => {
    const result = parseHookPayload({ ...base, hook_event_name: 'FutureEvent', tool_response: { big: 'x' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect('tool_response' in result.payload).toBe(false);
  });

  it('never reads inside a non-Agent tool_response and handles 5 MB quickly', () => {
    const touched: string[] = [];
    const trap = new Proxy(
      { content: 'x'.repeat(5 * 1024 * 1024) },
      {
        get(target, key, receiver) {
          touched.push(String(key));
          return Reflect.get(target, key, receiver) as unknown;
        },
        ownKeys(target) {
          touched.push('ownKeys');
          return Reflect.ownKeys(target);
        },
      },
    );
    const body = {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'cat big.log' },
      tool_use_id: 'toolu_1',
      tool_response: trap,
    };
    parseHookPayload(body); // warm-up so the timing measures steady state, not first-call compilation
    touched.length = 0;

    const started = performance.now();
    const result = parseHookPayload(body);
    const elapsed = performance.now() - started;

    expect(result).toMatchObject({ ok: true, known: true });
    if (result.ok) expect('tool_response' in result.payload).toBe(false);
    expect(touched).toEqual([]);
    expect(elapsed).toBeLessThan(20);
  });

  it('reads only the four link fields from an Agent tool_response', () => {
    const touched: string[] = [];
    const response = new Proxy(
      { agentId: 'agent-3', isAsync: false, status: 'completed', resolvedModel: 'm', content: 'big', usage: {} },
      {
        get(target, key, receiver) {
          touched.push(String(key));
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    const result = parseHookPayload({
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_response: response,
    });
    expect(result).toMatchObject({
      ok: true,
      agentLink: { agentId: 'agent-3', isAsync: false, status: 'completed', resolvedModel: 'm' },
    });
    expect(new Set(touched)).toEqual(new Set(['agentId', 'isAsync', 'status', 'resolvedModel']));
  });
});
