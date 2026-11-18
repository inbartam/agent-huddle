import { describe, expect, it } from 'vitest';
import { agentKey, CLIP_LIMITS, type HuddleEvent } from '@huddle/shared';
import { parseHookPayload, type ParseHookResult } from '../ingest/schemas.js';
import { listFixtureFiles, NO_AGENT_LINK_FIXTURES, readFixture, type FixtureLine } from '../test/fixtures.js';
import { hookFacts, storedPolicyFacts } from './hook-facts.js';
import {
  inputDigest,
  normalizeHook,
  OMITTED_INPUT_VALUE,
  STORED_TOOL_INPUT_KEYS,
  type NormalizeHookContext,
  type NormalizableHook,
} from './hooks.js';

/** Deterministic context: receivedAt is the fixture line's own timestamp, ids are a counter. */
function counterCtx(receivedAt: string, counter: { n: number }): NormalizeHookContext {
  return {
    receivedAt,
    nextId: () => {
      counter.n += 1;
      return `evt-${String(counter.n).padStart(4, '0')}`;
    },
  };
}

function parseOk(body: unknown): NormalizableHook {
  const result: ParseHookResult = parseHookPayload(body);
  if (!result.ok) throw new Error(`fixture body did not parse: ${result.error}`);
  return result;
}

interface NormalizedLine {
  line: FixtureLine;
  parsed: NormalizableHook;
  events: HuddleEvent[];
}

function normalizeFixture(name: string): NormalizedLine[] {
  const counter = { n: 0 };
  return readFixture(name)
    .filter((line) => line.kind === 'hook')
    .map((line) => {
      const parsed = parseOk(line.payload);
      return { line, parsed, events: normalizeHook(parsed, counterCtx(line.t, counter)) };
    });
}

function allEvents(name: string): HuddleEvent[] {
  return normalizeFixture(name).flatMap((n) => n.events);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every [key, value] pair in a JSON-like value, depth first, with the dotted path. */
function* walk(value: unknown, path = ''): Generator<[string, string, unknown]> {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* walk(item, `${path}[${String(i)}]`);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      yield [key, `${path}.${key}`, item];
      yield* walk(item, `${path}.${key}`);
    }
  }
}

/** The clip limit for each free-text field, by event type and dotted path. */
const FIELD_LIMITS: Record<string, number> = {
  'prompt.submitted:.text': CLIP_LIMITS.prompt,
  'agent.spawn_requested:.brief': CLIP_LIMITS.brief,
  'agent.spawn_requested:.title': CLIP_LIMITS.summary,
  'agent.stopped:.result': CLIP_LIMITS.result,
  'turn.ended:.lastMessage': CLIP_LIMITS.result,
  'turn.failed:.error': CLIP_LIMITS.error,
  'tool.started:.summary': CLIP_LIMITS.summary,
  'tool.failed:.error': CLIP_LIMITS.error,
  'notification.raised:.message': CLIP_LIMITS.message,
  'task.created:.subject': CLIP_LIMITS.summary,
  'task.created:.description': CLIP_LIMITS.description,
  'session.started:.title': CLIP_LIMITS.summary,
  'session.ended:.reason': CLIP_LIMITS.summary,
  'approval.requested:.request.summary': CLIP_LIMITS.summary,
};
const MAX_LIMIT = Math.max(...Object.values(CLIP_LIMITS));

function limitFor(event: HuddleEvent, path: string): number {
  const exact = FIELD_LIMITS[`${event.type}:${path}`];
  if (exact !== undefined) return exact;
  if (event.type === 'approval.requested' && path.startsWith('.request.toolInput.')) return CLIP_LIMITS.message;
  if (event.type === 'question.asked') {
    if (/^\.request\.questions\[\d+\]\.question$/.test(path)) return CLIP_LIMITS.message;
    if (/^\.request\.questions\[\d+\]\.header$/.test(path)) return CLIP_LIMITS.summary;
    if (/^\.request\.questions\[\d+\]\.options\[\d+\]\.label$/.test(path)) return CLIP_LIMITS.summary;
    if (/^\.request\.questions\[\d+\]\.options\[\d+\]\.description$/.test(path)) return CLIP_LIMITS.description;
  }
  return MAX_LIMIT;
}

function expectClipped(events: readonly HuddleEvent[]): void {
  for (const event of events) {
    for (const [, path, value] of walk(event)) {
      if (typeof value === 'string') {
        expect(value.length, `${event.type} ${path}`).toBeLessThanOrEqual(limitFor(event, path));
      }
    }
  }
}

const FORBIDDEN_KEYS = new Set(['tool_response', 'content', 'new_string', 'old_string']);

function expectNoForbiddenKeys(events: readonly HuddleEvent[]): void {
  for (const event of events) {
    for (const [key, path] of walk(event)) {
      expect(FORBIDDEN_KEYS.has(key), `${event.type} carries ${path}`).toBe(false);
    }
  }
}

const SESSION = 'session-1';
const T0 = '2026-11-13T12:00:00.000Z';

function normalizeOne(body: Record<string, unknown>): HuddleEvent[] {
  return normalizeHook(parseOk({ session_id: SESSION, ...body }), counterCtx(T0, { n: 0 }));
}

function ofType<T extends HuddleEvent['type']>(events: readonly HuddleEvent[], type: T) {
  return events.filter((e): e is Extract<HuddleEvent, { type: T }> => e.type === type);
}

const fixtures = listFixtureFiles();

describe('normalizeHook over every fixture', () => {
  it('finds the fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(9);
  });

  describe.each(fixtures)('%s', (name) => {
    it('matches the golden event snapshot', async () => {
      const golden = normalizeFixture(name).map(({ line, events }) => ({ t: line.t, hook: line.event, events }));
      await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(
        `./__snapshots__/hooks/${name.replace(/\.jsonl$/, '.json')}`,
      );
    });

    it('stores no tool_response, file contents or edit strings', () => {
      expectNoForbiddenKeys(allEvents(name));
    });

    it('keeps every text field within CLIP_LIMITS', () => {
      expectClipped(allEvents(name));
    });

    it('is deterministic for the same input and context', () => {
      expect(JSON.stringify(allEvents(name))).toBe(JSON.stringify(allEvents(name)));
    });

    it('uses the receive time as ts and the hook source', () => {
      for (const { line, events } of normalizeFixture(name)) {
        for (const event of events) {
          expect(event.ts).toBe(Date.parse(line.t));
          expect(event.source).toBe('hook');
          expect(event.sessionId).toBe((line.payload as { session_id: string }).session_id);
        }
      }
    });

    it('links every PostToolUse(Agent) to its child, with the caller as parent', () => {
      if (NO_AGENT_LINK_FIXTURES.has(name)) return;
      for (const { parsed, events } of normalizeFixture(name)) {
        if (!parsed.known || parsed.payload.hook_event_name !== 'PostToolUse') continue;
        if (parsed.payload.tool_name !== 'Agent') continue;
        const link = parsed.agentLink;
        expect(link, 'every PostToolUse(Agent) fixture line has an agentId').toBeDefined();
        const linked = ofType(events, 'agent.linked');
        expect(linked).toHaveLength(1);
        const sessionId = parsed.payload.session_id;
        expect(linked[0]).toMatchObject({
          toolUseId: parsed.payload.tool_use_id,
          childAgentId: link?.agentId,
          parentKey: agentKey(sessionId, parsed.payload.agent_id),
          agentKey: agentKey(sessionId, link?.agentId),
          link: 'exact',
        });
      }
    });
  });
});

describe('prompt kinds', () => {
  function kinds(name: string): string[] {
    return ofType(allEvents(name), 'prompt.submitted').map((e) => e.kind ?? 'absent');
  }

  it('classifies agent messages (agent-messages.jsonl)', () => {
    expect(kinds('agent-messages.jsonl')).toEqual(['user', 'agent_message', 'agent_message']);
  });

  it('classifies task notifications (parallel-subagents.jsonl)', () => {
    expect(kinds('parallel-subagents.jsonl')).toEqual(['user', 'task_notification', 'task_notification']);
  });

  it('matches the opening tag only, ignoring leading whitespace and missing closing tags', () => {
    const kindOf = (prompt: string) =>
      ofType(normalizeOne({ hook_event_name: 'UserPromptSubmit', prompt }), 'prompt.submitted')[0]?.kind;
    expect(kindOf('\n  <task-notification><task-id>a1</task-id>')).toBe('task_notification');
    expect(kindOf('<agent-message from="a2">hi')).toBe('agent_message');
    expect(kindOf('please read <task-notification> later')).toBe('user');
    expect(kindOf('<agent-messages>not a message')).toBe('user');
    expect(kindOf('')).toBe('user');
  });
});

describe('agent links from task notifications', () => {
  it('emits an exact link for each notification with task-id and tool-use-id (parallel-subagents.jsonl)', () => {
    const fromPrompts = normalizeFixture('parallel-subagents.jsonl')
      .filter(({ line }) => line.event === 'UserPromptSubmit')
      .flatMap(({ events }) => ofType(events, 'agent.linked'));
    expect(fromPrompts).toEqual([
      expect.objectContaining({
        childAgentId: 'agent-1',
        toolUseId: 'tool_use-2',
        parentKey: 'session-1',
        link: 'exact',
      }),
      expect.objectContaining({
        childAgentId: 'agent-2',
        toolUseId: 'tool_use-3',
        parentKey: 'session-1',
        link: 'exact',
      }),
    ]);
    expect(fromPrompts[0]?.agentKey).toBe('session-1::agent-1');
  });

  it('emits no link when either id is missing', () => {
    const events = normalizeOne({
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification><task-id>agent-9</task-id><status>completed</status>',
    });
    expect(ofType(events, 'agent.linked')).toHaveLength(0);
  });

  it('places the nested Explore agent under general-purpose (nested-subagents.jsonl)', () => {
    const linked = ofType(allEvents('nested-subagents.jsonl'), 'agent.linked');
    expect(linked.map((e) => [e.childAgentId, e.parentKey])).toEqual([
      ['agent-2', 'session-1::agent-1'],
      ['agent-1', 'session-1'],
    ]);
  });
});

describe('hidden helpers and compaction', () => {
  it('turns the bare SubagentStop of a compaction into nothing (compaction.jsonl)', () => {
    const lines = normalizeFixture('compaction.jsonl');
    const bare = lines.filter(({ line }) => line.event === 'SubagentStop');
    expect(bare).toHaveLength(1);
    expect(bare[0]?.events).toEqual([]);
    const events = lines.flatMap((l) => l.events);
    expect(ofType(events, 'agent.started')).toHaveLength(0);
    expect(events.every((e) => e.agentKey === 'session-1')).toBe(true);
  });

  it('turns the helper SubagentStop into nothing (interactive-helpers.jsonl)', () => {
    const events = allEvents('interactive-helpers.jsonl');
    expect(ofType(events, 'agent.started')).toHaveLength(0);
    expect(events.every((e) => e.agentKey === 'session-1')).toBe(true);
  });
});

describe('subagent lifecycle', () => {
  it('starts a subagent under the main agent provisionally', () => {
    const events = normalizeOne({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'agent.started',
        agentKey: 'session-1::a1',
        agentId: 'a1',
        role: 'Explore',
        parentKey: 'session-1',
      }),
    ]);
  });

  it('emits the same start event again for a resumed subagent (the reducer reopens the node)', () => {
    const body = { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' };
    const strip = (events: HuddleEvent[]) => events.map(({ id: _id, ...rest }) => rest);
    expect(strip(normalizeOne(body))).toEqual(strip(normalizeOne(body)));
  });

  it('ends a real subagent with turn.ended and agent.stopped', () => {
    const events = normalizeOne({
      hook_event_name: 'SubagentStop',
      agent_id: 'a1',
      agent_type: 'Explore',
      last_assistant_message: 'done',
      background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }],
    });
    expect(events.map((e) => e.type)).toEqual(['turn.ended', 'agent.stopped']);
    expect(events[1]).toMatchObject({ agentKey: 'session-1::a1', agentId: 'a1', result: 'done' });
  });
});

describe('an empty agent_id on Subagent* (A1-02)', () => {
  it('does not end the main agent: SubagentStop with agent_id "" gives no events', () => {
    expect(normalizeOne({ hook_event_name: 'SubagentStop', agent_id: '', agent_type: 'x' })).toEqual([]);
  });

  it('does not start a node on the root key: SubagentStart with agent_id "" gives no events', () => {
    expect(normalizeOne({ hook_event_name: 'SubagentStart', agent_id: '', agent_type: 'x' })).toEqual([]);
  });
});

describe('background agents on Stop', () => {
  it('lists running subagents, then none (parallel-subagents.jsonl)', () => {
    const stops = normalizeFixture('parallel-subagents.jsonl')
      .filter(({ line }) => line.event === 'Stop')
      .flatMap(({ events }) => ofType(events, 'turn.ended'))
      .map((e) => e.backgroundAgentIds);
    expect(stops).toEqual([['agent-1', 'agent-2'], ['agent-2'], []]);
  });

  it('is null (unknown) when background_tasks is absent', () => {
    const [ended] = ofType(normalizeOne({ hook_event_name: 'Stop' }), 'turn.ended');
    expect(ended?.backgroundAgentIds).toBeNull();
    expect(ended?.lastMessage).toBeNull();
  });

  it('keeps only subagent entries that have an id', () => {
    const [ended] = ofType(
      normalizeOne({
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'a1', type: 'subagent' },
          { id: 'sh1', type: 'shell' },
          { type: 'subagent' },
          { id: 'a2' },
        ],
      }),
      'turn.ended',
    );
    expect(ended?.backgroundAgentIds).toEqual(['a1', 'a2']);
  });
});

describe('models', () => {
  it('reads SessionStart.model (compaction.jsonl)', () => {
    const observed = ofType(allEvents('compaction.jsonl'), 'model.observed');
    expect(observed).toEqual([
      expect.objectContaining({ model: 'claude-opus-5-5', via: 'session_start', agentKey: 'session-1' }),
    ]);
  });

  it('gives the child its resolvedModel from the Agent call (agent-messages.jsonl)', () => {
    const observed = ofType(allEvents('agent-messages.jsonl'), 'model.observed');
    expect(observed.map((e) => [e.agentKey, e.via])).toEqual([
      ['session-1::agent-1', 'agent_call'],
      ['session-1::agent-2', 'agent_call'],
    ]);
    expect(observed.some((e) => e.agentKey === 'session-1')).toBe(false);
  });

  it('records a model switch as both model.changed and model.observed', () => {
    const events = normalizeOne({
      hook_event_name: 'PostModelSwitch',
      from_model: 'claude-opus-5-5',
      to_model: 'claude-sonnet-5',
    });
    expect(events).toEqual([
      expect.objectContaining({ type: 'model.changed', from: 'claude-opus-5-5', to: 'claude-sonnet-5' }),
      expect.objectContaining({ type: 'model.observed', model: 'claude-sonnet-5', via: 'switch' }),
    ]);
  });

  it('emits nothing for a switch without to_model', () => {
    expect(normalizeOne({ hook_event_name: 'PostModelSwitch', from_model: 'x' })).toEqual([]);
  });
});

describe('stored approval input is an allowlist (M5 security review L5)', () => {
  /** The recorded PermissionRequest of permission-allow.jsonl, its tool_input widened by `extra`. */
  function recordedRequest(extra: Record<string, unknown>) {
    const line = readFixture('permission-allow.jsonl').find(
      (l) => l.kind === 'hook' && l.event === 'PermissionRequest',
    );
    if (line === undefined) throw new Error('no PermissionRequest in permission-allow.jsonl');
    const payload = line.payload as Record<string, unknown> & { tool_input: Record<string, unknown> };
    const raw = { ...payload.tool_input, ...extra };
    const parsed = parseOk({ ...payload, tool_input: raw });
    const events = normalizeHook(parsed, counterCtx(line.t, { n: 0 }));
    const requested = ofType(events, 'approval.requested')[0];
    if (requested === undefined) throw new Error('no approval.requested');
    return { raw, parsed, requested, recorded: payload.tool_input };
  }

  it('keeps the recorded summary keys as before and marks every other key <omitted>', () => {
    const secret = 'FILE BODY 4471';
    const { requested, recorded } = recordedRequest({
      content: secret,
      new_string: secret,
      env: { TOKEN: secret },
      dangerouslyDisableSandbox: true,
      shell_id: 'abc',
      timeout: 120000,
      run_in_background: false,
      file_path: { nested: secret },
    });
    // The recorded keys (command, description) are stored exactly as before.
    for (const key of Object.keys(recorded)) expect(STORED_TOOL_INPUT_KEYS.has(key)).toBe(true);
    // Content keys are left out entirely, names too (as before); other unknown keys show only that they existed.
    expect(requested.request.toolInput).toEqual({
      ...recorded,
      env: OMITTED_INPUT_VALUE,
      dangerouslyDisableSandbox: OMITTED_INPUT_VALUE,
      shell_id: OMITTED_INPUT_VALUE,
      timeout: 120000,
      run_in_background: false,
    });
    expect(JSON.stringify(requested)).not.toContain(secret);
    expectNoForbiddenKeys([requested]);
  });

  it('the summary and the call digest still come from the raw input; the rule preview still reads the command', () => {
    const { raw, parsed, requested } = recordedRequest({ content: 'body', extra_flag: 'x' });
    const toolName = requested.request.toolName;
    if (!parsed.known || parsed.payload.hook_event_name !== 'PermissionRequest') throw new Error('not a request');
    expect(hookFacts(parsed)).toMatchObject({
      kind: 'permission_request',
      call: { digest: inputDigest(toolName, raw) },
    });
    const command = typeof raw.command === 'string' ? raw.command : null;
    expect(storedPolicyFacts(toolName, requested.request.toolInput, null).command).toBe(command);
    expect(requested.request.summary).toBe(command);
  });

  it('bounds a hostile input: at most 64 keys, overlong key names left out', () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${String(i)}`, i]));
    const { requested } = recordedRequest({ ['x'.repeat(65)]: 1, ...many });
    const keys = Object.keys(requested.request.toolInput);
    expect(keys.length).toBe(64);
    expect(keys).not.toContain('x'.repeat(65));
  });
});

describe('tool summaries (F8)', () => {
  function started(toolName: string, toolInput: Record<string, unknown>) {
    return ofType(
      normalizeOne({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: 't1' }),
      'tool.started',
    )[0];
  }

  it('summarizes Read, Edit and Write by path, never by content', () => {
    const secret = 'SECRET FILE BODY';
    expect(started('Read', { file_path: 'C:/p/a.ts' })).toMatchObject({ summary: 'C:/p/a.ts', filePath: 'C:/p/a.ts' });
    const edit = started('Edit', { file_path: 'C:/p/b.ts', old_string: secret, new_string: secret });
    const write = started('Write', { file_path: 'C:/p/c.ts', content: secret });
    expect(edit).toMatchObject({ summary: 'C:/p/b.ts', filePath: 'C:/p/b.ts' });
    expect(write).toMatchObject({ summary: 'C:/p/c.ts', filePath: 'C:/p/c.ts' });
    expect(JSON.stringify([edit, write])).not.toContain(secret);
  });

  it('summarizes Bash by its command on one line, clipped', () => {
    const tool = started('Bash', { command: `echo a\n  && echo b ${'x'.repeat(5000)}` });
    expect(tool?.summary.startsWith('echo a && echo b')).toBe(true);
    expect(tool?.summary.length).toBeLessThanOrEqual(CLIP_LIMITS.summary);
    expect(tool?.filePath).toBeNull();
  });

  it('falls back to the tool name', () => {
    expect(started('mcp__srv__do', { anything: 1 })?.summary).toBe('mcp__srv__do');
  });

  it('gives the same digest for the same input and a different one otherwise', () => {
    const a = started('Read', { file_path: 'a', limit: 5 })?.inputDigest;
    const b = started('Read', { limit: 5, file_path: 'a' })?.inputDigest;
    const c = started('Read', { file_path: 'b', limit: 5 })?.inputDigest;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('turns PreToolUse(Agent) into tool.started and agent.spawn_requested', () => {
    const events = normalizeOne({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_use_id: 't9',
      tool_input: { description: 'Look around', prompt: 'p'.repeat(9000), subagent_type: 'Explore', model: 'haiku' },
    });
    expect(events.map((e) => e.type)).toEqual(['tool.started', 'agent.spawn_requested']);
    expect(events[1]).toMatchObject({ toolUseId: 't9', role: 'Explore', title: 'Look around', model: 'haiku' });
    expectClipped(events);
  });
});

describe('AskUserQuestion (F11)', () => {
  function asked(body: Record<string, unknown>) {
    return normalizeOne({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', ...body });
  }

  it('emits tool.started then question.asked keyed by the tool_use_id (interactive-helpers.jsonl)', () => {
    const lines = normalizeFixture('interactive-helpers.jsonl').filter(
      ({ parsed }) =>
        parsed.known &&
        parsed.payload.hook_event_name === 'PreToolUse' &&
        parsed.payload.tool_name === 'AskUserQuestion',
    );
    // The fixture asks the same question twice (S5 was run twice in a row).
    expect(lines).toHaveLength(2);
    for (const [index, { line, events }] of lines.entries()) {
      expect(events.map((e) => e.type)).toEqual(['tool.started', 'question.asked']);
      const [question] = ofType(events, 'question.asked');
      expect(question?.request).toEqual({
        requestId: `tool_use-${String(index + 1)}`,
        agentKey: agentKey('session-1'),
        receivedAt: Date.parse(line.t),
        // No holdTimeouts in this context: the deadline is unknown, never 0.
        expiresAt: null,
        questions: [
          {
            question: '(scrubbed text)',
            header: 'Color',
            options: [
              { label: '(scrubbed text)', description: '(scrubbed text)' },
              { label: '(scrubbed text)', description: '(scrubbed text)' },
              { label: '(scrubbed text)', description: '(scrubbed text)' },
            ],
            multiSelect: false,
          },
        ],
      });
      // The started tool call and the question share the id the broker matches the held request by.
      expect(ofType(events, 'tool.started')[0]?.toolUseId).toBe(question?.request.requestId);
    }
  });

  it('keeps multiSelect, several questions, and options without description or header', () => {
    const events = asked({
      tool_use_id: 'tu-2',
      tool_input: {
        questions: [
          {
            question: 'Which checks?',
            header: 'Checks',
            options: [{ label: 'Lint' }, { label: 'Tests' }],
            multiSelect: true,
          },
          { question: 'Ship it?', options: [{ label: 'Yes', description: 'Now' }, { label: 'No' }], extra: 'kept out' },
        ],
      },
    });
    const [question] = ofType(events, 'question.asked');
    expect(question?.request.requestId).toBe('tu-2');
    expect(question?.request.questions).toEqual([
      {
        question: 'Which checks?',
        header: 'Checks',
        options: [{ label: 'Lint' }, { label: 'Tests' }],
        multiSelect: true,
      },
      { question: 'Ship it?', options: [{ label: 'Yes', description: 'Now' }, { label: 'No' }], multiSelect: false },
    ]);
  });

  it('clips and masks question text', () => {
    const huge = 'q'.repeat(20_000);
    const events = asked({
      tool_use_id: 'tu-3',
      tool_input: {
        questions: [
          {
            question: `${huge} sk-ant-api03-${'a'.repeat(40)}`,
            header: huge,
            options: [{ label: huge, description: huge }],
          },
        ],
      },
    });
    expect(ofType(events, 'question.asked')).toHaveLength(1);
    expectClipped(events);
  });

  it.each([
    ['no tool_input', {}],
    ['questions not an array', { tool_input: { questions: 'Pick one' } }],
    ['empty questions', { tool_input: { questions: [] } }],
    ['question text missing', { tool_input: { questions: [{ options: [{ label: 'A' }] }] } }],
    ['option label not a string', { tool_input: { questions: [{ question: 'Q', options: [{ label: 3 }] }] } }],
    ['multiSelect not a boolean', { tool_input: { questions: [{ question: 'Q', options: [], multiSelect: 'yes' }] } }],
    [
      'too many questions',
      { tool_input: { questions: Array.from({ length: 9 }, () => ({ question: 'Q', options: [] })) } },
    ],
  ])('emits only tool.started for malformed tool_input: %s', (_name, body) => {
    let events: HuddleEvent[] = [];
    expect(() => (events = asked({ tool_use_id: 'tu-4', ...body }))).not.toThrow();
    expect(events.map((e) => e.type)).toEqual(['tool.started']);
  });

  it('emits only tool.started without a tool_use_id (nothing to match the held request by)', () => {
    const events = asked({ tool_input: { questions: [{ question: 'Q', options: [{ label: 'A' }] }] } });
    expect(events.map((e) => e.type)).toEqual(['tool.started']);
    expect(ofType(events, 'tool.started')[0]?.toolUseId).toBeNull();
  });
});

describe('PermissionRequest(AskUserQuestion): Claude Code own question box (2.1.325)', () => {
  it('emits nothing (no approval card); input taken from the recorded fixtures', () => {
    const request = readFixture('permission-allow.jsonl').find((l) => l.event === 'PermissionRequest');
    const ask = readFixture('interactive-helpers.jsonl').find((l) => l.event === 'PreToolUse');
    if (request === undefined || ask === undefined) throw new Error('fixture changed');
    const askInput = (ask.payload as { tool_input: unknown }).tool_input;
    const payload = { ...(request.payload as object), tool_name: 'AskUserQuestion', tool_input: askInput };
    expect(normalizeHook(parseOk(payload), counterCtx(request.t, { n: 0 }))).toEqual([]);
    // The same request for another tool is still an approval.
    expect(normalizeHook(parseOk(request.payload), counterCtx(request.t, { n: 0 })).map((e) => e.type)).toEqual([
      'approval.requested',
    ]);
  });
});

describe('hold timeouts (expiresAt)', () => {
  const permission = { session_id: SESSION, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} };

  function expiresAt(ctx: Partial<NormalizeHookContext>): number | null | undefined {
    const events = normalizeHook(parseOk(permission), { ...counterCtx(T0, { n: 0 }), ...ctx });
    return ofType(events, 'approval.requested')[0]?.request.expiresAt;
  }

  it('is receive time plus the PermissionRequest timeout', () => {
    expect(expiresAt({ holdTimeouts: { PreToolUse: 600, PermissionRequest: 300 } })).toBe(Date.parse(T0) + 300_000);
  });

  it('is null (unknown, never 0) without a usable timeout or receive time', () => {
    expect(expiresAt({})).toBeNull();
    expect(expiresAt({ holdTimeouts: { PreToolUse: 600 } })).toBeNull();
    expect(expiresAt({ holdTimeouts: { PermissionRequest: 0 } })).toBeNull();
    expect(expiresAt({ holdTimeouts: { PermissionRequest: Number.NaN } })).toBeNull();
    expect(expiresAt({ receivedAt: 'garbage', holdTimeouts: { PermissionRequest: 600 } })).toBeNull();
  });

  it('fills the expiresAt of a question from the PreToolUse timeout', () => {
    const ask = {
      session_id: SESSION,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tu-exp',
      tool_input: { questions: [{ question: 'Q', options: [{ label: 'A' }] }] },
    };
    const question = (ctx: Partial<NormalizeHookContext>) =>
      ofType(normalizeHook(parseOk(ask), { ...counterCtx(T0, { n: 0 }), ...ctx }), 'question.asked')[0]?.request;
    expect(question({ holdTimeouts: { PreToolUse: 600, PermissionRequest: 300 } })?.expiresAt).toBe(
      Date.parse(T0) + 600_000,
    );
    expect(question({ holdTimeouts: { PermissionRequest: 300 } })?.expiresAt).toBeNull();
  });
});

describe('task in progress from TaskUpdate (S4b)', () => {
  function update(toolInput: Record<string, unknown>, hook = 'PostToolUse', extra: Record<string, unknown> = {}) {
    return normalizeOne({
      hook_event_name: hook,
      tool_name: 'TaskUpdate',
      tool_input: toolInput,
      tool_use_id: 'tu-1',
      ...extra,
    });
  }

  it.each([
    ['taskId', { taskId: '2', status: 'in_progress' }],
    ['task_id', { task_id: '2', status: 'in_progress' }],
    ['id', { id: '2', status: 'in_progress' }],
    ['a numeric id', { taskId: 2, status: 'in_progress' }],
  ])('emits task.started from %s, after tool.finished', (_name, input) => {
    const events = update(input);
    expect(events.map((e) => e.type)).toEqual(['tool.finished', 'task.started']);
    expect(ofType(events, 'task.started')[0]).toMatchObject({ taskId: '2', agentKey: agentKey(SESSION) });
  });

  it('attributes it to the subagent that made the update', () => {
    const [started] = ofType(
      update({ taskId: '1', status: 'in_progress' }, 'PostToolUse', { agent_id: 'a1' }),
      'task.started',
    );
    expect(started?.agentKey).toBe(agentKey(SESSION, 'a1'));
  });

  it.each([
    ['no id', { status: 'in_progress' }],
    ['an empty id', { taskId: '', status: 'in_progress' }],
    ['an id of the wrong type', { taskId: { x: 1 }, status: 'in_progress' }],
    ['a non-finite number', { taskId: Number.NaN, status: 'in_progress' }],
    ['status completed', { taskId: '1', status: 'completed' }],
    ['status pending', { taskId: '1', status: 'pending' }],
    ['no status', { taskId: '1' }],
  ])('emits no task.started for %s', (_name, input) => {
    const events = update(input);
    expect(events.map((e) => e.type)).toEqual(['tool.finished']);
  });

  it('emits no task.started on PreToolUse (the update may still fail) or PostToolUseFailure', () => {
    expect(ofType(update({ taskId: '1', status: 'in_progress' }, 'PreToolUse'), 'task.started')).toHaveLength(0);
    expect(ofType(update({ taskId: '1', status: 'in_progress' }, 'PostToolUseFailure'), 'task.started')).toHaveLength(
      0,
    );
  });

  it('ignores the same input on another tool', () => {
    const events = normalizeOne({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { taskId: '1', status: 'in_progress' },
    });
    expect(ofType(events, 'task.started')).toHaveLength(0);
  });

  it('clips an oversized task id', () => {
    const [started] = ofType(update({ taskId: 'z'.repeat(20_000), status: 'in_progress' }), 'task.started');
    expect(started?.taskId.length).toBeLessThanOrEqual(CLIP_LIMITS.id);
  });

  it('reads the recorded run: three tasks started, in order (tasks-enabled.jsonl)', () => {
    expect(ofType(allEvents('tasks-enabled.jsonl'), 'task.started').map((e) => e.taskId)).toEqual(['1', '2', '3']);
  });
});

describe('clipping and privacy on oversized input', () => {
  const huge = 'y'.repeat(20_000);

  it('clips every free-text field', () => {
    const events = [
      ...normalizeOne({ hook_event_name: 'UserPromptSubmit', prompt: huge, session_title: huge }),
      ...normalizeOne({ hook_event_name: 'SessionStart', session_title: huge }),
      ...normalizeOne({ hook_event_name: 'Stop', last_assistant_message: huge }),
      ...normalizeOne({
        hook_event_name: 'SubagentStop',
        agent_id: 'a',
        agent_type: 'X',
        last_assistant_message: huge,
      }),
      ...normalizeOne({ hook_event_name: 'PostToolUseFailure', tool_name: 'Read', error: huge }),
      ...normalizeOne({ hook_event_name: 'Notification', message: huge }),
      ...normalizeOne({ hook_event_name: 'TaskCreated', task_id: 't', task_subject: huge, task_description: huge }),
      ...normalizeOne({ hook_event_name: 'SessionEnd', reason: huge }),
      ...normalizeOne({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', reason: huge }),
      ...normalizeOne({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: huge } }),
    ];
    expect(events.length).toBeGreaterThanOrEqual(10);
    expectClipped(events);
  });

  it('keeps file contents out of approval requests', () => {
    const events = normalizeOne({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: 'C:/p/x.ts', content: 'BODY', nested: { content: 'BODY' } },
    });
    const [requested] = ofType(events, 'approval.requested');
    expect(requested?.request).toMatchObject({
      toolName: 'Write',
      summary: 'C:/p/x.ts',
      toolInput: { file_path: 'C:/p/x.ts' },
    });
    expect(JSON.stringify(events)).not.toContain('BODY');
    expectNoForbiddenKeys(events);
  });

  it('never copies tool_response, even when the raw body had one', () => {
    const events = normalizeOne({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_use_id: 't',
      tool_input: { file_path: 'a' },
      tool_response: { file: { content: 'BODY' } },
    });
    expect(JSON.stringify(events)).not.toContain('BODY');
    expectNoForbiddenKeys(events);
  });
});

describe('robustness', () => {
  it('returns [] for an unknown hook event', () => {
    expect(normalizeOne({ hook_event_name: 'SomethingNew', extra: 1 })).toEqual([]);
  });

  it('never throws on odd parse results', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 2000; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.x = next;
      cursor = next;
    }
    const bodies: Record<string, unknown>[] = [
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 42 } },
      { hook_event_name: 'PreToolUse', tool_name: 'Agent' },
      { hook_event_name: 'PreToolUse', tool_name: 'Deep', tool_input: deep },
      { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_response: { agentId: 'a' } },
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'SubagentStop', agent_id: 'a' },
      { hook_event_name: 'StopFailure', error: { weird: true } },
      { hook_event_name: 'InstructionsLoaded' },
      { hook_event_name: 'TeammateIdle' },
      { hook_event_name: 'PreCompact' },
      { hook_event_name: 'SessionEnd' },
    ];
    for (const body of bodies) {
      expect(() => normalizeOne(body), String(body.hook_event_name)).not.toThrow();
    }
    const hand: NormalizableHook = { ok: true, known: false, payload: { session_id: 's', hook_event_name: 'X' } };
    expect(normalizeHook(hand, { receivedAt: 'not a date', nextId: () => 'id' })).toEqual([]);
  });

  it('keeps ts a finite number when receivedAt is not a date', () => {
    const events = normalizeHook(parseOk({ session_id: 's', hook_event_name: 'Stop' }), {
      receivedAt: 'garbage',
      nextId: () => 'id',
    });
    expect(events.every((e) => Number.isFinite(e.ts))).toBe(true);
  });

  it('links a PostToolUse(Agent) without tool_use_id only through its model', () => {
    const events = normalizeOne({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_response: { agentId: 'a7', resolvedModel: 'm' },
    });
    expect(ofType(events, 'agent.linked')).toHaveLength(0);
    expect(ofType(events, 'model.observed')).toEqual([
      expect.objectContaining({ agentKey: 'session-1::a7', model: 'm' }),
    ]);
  });
});
