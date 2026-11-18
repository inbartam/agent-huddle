/**
 * Test helper for the report tests (M5, F23 F24): hand-made events with increasing ts, and one small session with a
 * subagent, an approval, failures, a write, stuck episodes, usage (with a duplicate and a helper request) and hostile
 * agent text in every free-text field the report shows. Not exported from the package.
 */
import { agentKey, type EventOfType, type HuddleEvent } from '@huddle/shared';

export type Fields<T extends HuddleEvent['type']> = Omit<
  EventOfType<T>,
  'id' | 'type' | 'ts' | 'sessionId' | 'agentKey' | 'source'
>;

export function builder(start = 1_800_000_000_000, step = 1000) {
  let n = 0;
  return function ev<T extends HuddleEvent['type']>(
    type: T,
    key: string,
    fields: Fields<T>,
    at: { sessionId?: string; source?: HuddleEvent['source']; ts?: number } = {},
  ): HuddleEvent {
    n += 1;
    return {
      id: `e${String(n).padStart(4, '0')}`,
      type,
      ts: at.ts ?? start + n * step,
      sessionId: at.sessionId ?? key.split('::')[0] ?? key,
      agentKey: key,
      source: at.source ?? 'hook',
      ...fields,
    } as unknown as HuddleEvent;
  };
}

export const HOSTILE = {
  title: '# [x](javascript:alert(1)) <img src=x>',
  prompt: '```\nrm -rf /\n```',
  handoffTitle: '![i](http://x/track.png)',
  path: 'C:/p/src/[a](b).ts',
  error: '`boom` *bold* | pipe _u_ <b>',
  summary: 'npm test <script>alert(1)</script>',
  result: '- [click](https://evil.example) www.evil.example',
} as const;

/** Text placed in an approval's tool input: it must never reach a report. */
export const INPUT_SENTINEL = 'TOOL-INPUT-SENTINEL-7f3a';

export const S = 'sess-report';
export const MAIN = agentKey(S);
export const SUB = agentKey(S, 'a1');

export function sampleSession(): HuddleEvent[] {
  const ev = builder();
  const stuck = (n: number): EventOfType<'attention.raised'>['item'] => ({
    id: `stuck:${SUB}`,
    kind: 'stuck',
    severity: 'warning',
    agentKey: SUB,
    title: `No activity ${String(n)}`,
    detail: 'quiet',
    createdAt: 0,
    resolvedAt: null,
  });
  return [
    ev('session.started', MAIN, {
      origin: 'attached',
      cwd: 'C:/p',
      title: HOSTILE.title,
      model: 'claude-opus-5-5',
      startKind: 'startup',
    }),
    ev('prompt.submitted', MAIN, { text: HOSTILE.prompt, promptId: 'p1', kind: 'user' }),
    ev('agent.spawn_requested', MAIN, {
      toolUseId: 'tu-agent',
      role: 'core-engineer',
      title: HOSTILE.handoffTitle,
      brief: 'brief',
      model: 'sonnet',
    }),
    ev('tool.started', MAIN, {
      toolUseId: 'tu-agent',
      toolName: 'Agent',
      summary: 'core-engineer',
      filePath: null,
      inputDigest: 'd0',
    }),
    ev('agent.started', SUB, { agentId: 'a1', role: 'core-engineer', parentKey: MAIN }),
    ev('model.observed', SUB, { model: 'claude-sonnet-5-5', via: 'agent_call' }),
    ev('tool.started', SUB, {
      toolUseId: 'tu-1',
      toolName: 'Edit',
      summary: HOSTILE.path,
      filePath: HOSTILE.path,
      inputDigest: 'd1',
    }),
    ev('tool.finished', SUB, { toolUseId: 'tu-1', toolName: 'Edit', durationMs: 5 }),
    ev('tool.started', SUB, {
      toolUseId: 'tu-2',
      toolName: 'Bash',
      summary: HOSTILE.summary,
      filePath: null,
      inputDigest: 'd2',
    }),
    ev('approval.requested', SUB, {
      request: {
        requestId: 'r1',
        agentKey: SUB,
        toolName: 'Bash',
        toolInput: { command: INPUT_SENTINEL },
        summary: HOSTILE.summary,
        receivedAt: 0,
        expiresAt: null,
        channel: 'hook',
      },
    }),
    ev(
      'approval.resolved',
      SUB,
      { requestId: 'r1', outcome: 'allowed', by: 'user', policyRuleId: null, message: null },
      { source: 'user' },
    ),
    ev('tool.failed', SUB, { toolUseId: 'tu-2', toolName: 'Bash', error: HOSTILE.error, interrupted: false }),
    ev('tool.started', SUB, {
      toolUseId: 'tu-3',
      toolName: 'Write',
      summary: 'C:/p/out.txt',
      filePath: 'C:/p/out.txt',
      inputDigest: 'd3',
    }),
    ev('tool.failed', SUB, { toolUseId: 'tu-3', toolName: 'Write', error: 'denied', interrupted: false }),
    ev('attention.raised', SUB, { item: stuck(1) }, { source: 'huddle' }),
    ev('attention.raised', SUB, { item: stuck(2) }, { source: 'huddle' }),
    ev('attention.resolved', SUB, { itemId: `stuck:${SUB}` }, { source: 'huddle' }),
    ev('attention.raised', SUB, { item: stuck(3) }, { source: 'huddle' }),
    ev(
      'usage.recorded',
      SUB,
      {
        model: 'claude-sonnet-5-5',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 1000,
        cacheCreationTokens: 10,
        estimatedCostUsd: 0.01,
        requestId: 'q1',
        querySourceKind: 'subagent',
      },
      { source: 'telemetry' },
    ),
    ev(
      'usage.recorded',
      SUB,
      {
        model: 'claude-sonnet-5-5',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 1000,
        cacheCreationTokens: 10,
        estimatedCostUsd: 0.01,
        requestId: 'q1',
        querySourceKind: 'subagent',
      },
      { source: 'telemetry' },
    ),
    ev('turn.ended', SUB, { lastMessage: null, backgroundAgentIds: null }),
    ev('agent.stopped', SUB, { agentId: 'a1', result: HOSTILE.result }),
    ev('tool.finished', MAIN, { toolUseId: 'tu-agent', toolName: 'Agent', durationMs: 9000 }),
    ev(
      'usage.recorded',
      MAIN,
      {
        model: 'claude-opus-5-5',
        inputTokens: 2000,
        outputTokens: 300,
        cacheReadTokens: 5000,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.2,
        requestId: 'q2',
        querySourceKind: 'main',
      },
      { source: 'telemetry' },
    ),
    ev(
      'usage.recorded',
      MAIN,
      {
        model: 'claude-haiku-5-5',
        inputTokens: 40,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.001,
        requestId: 'q3',
        querySourceKind: 'helper',
      },
      { source: 'telemetry' },
    ),
    ev('turn.ended', MAIN, { lastMessage: null, backgroundAgentIds: [] }),
    ev('session.ended', MAIN, { reason: 'prompt_input_exit' }),
  ];
}
