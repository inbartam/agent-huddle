/**
 * Test helper: drives the pure broker (`decide`) the way the runtime does, without HTTP or timers.
 *
 * A hook payload goes through the real chain (parseHookPayload -> normalizeHook -> reduce -> hookFacts -> decide);
 * effects are applied as the runtime applies them, assuming every answer is sent unless the test closes the hold
 * first. Payload shapes are copied from fixtures/permission-allow.jsonl and fixtures/interactive-helpers.jsonl.
 * Time is `sim.now`, set by the test; ids are a counter. Not exported from the package.
 */
import type { HuddleEvent } from '@huddle/shared';
import { decide } from '../broker/decide.js';
import type {
  BrokerCommand,
  BrokerCtx,
  BrokerEffects,
  BrokerInput,
  BrokerView,
  HeldEntry,
  RuleHook,
} from '../broker/model.js';
import { droppedByEnd } from '../broker/outbox.js';
import type { HookReplyDecision } from '../ingest/hook-replies.js';
import { parseHookPayload } from '../ingest/schemas.js';
import { hookFacts } from '../normalize/hook-facts.js';
import { normalizeHook } from '../normalize/hooks.js';
import { initialState, reduce, type ReducerState } from '../state/reduce.js';

export const T0 = Date.parse('2026-11-14T10:00:00.000Z');
export const SESSION = 'session-1';
export const TIMEOUT_MS = 600_000;

const BASE = {
  session_id: SESSION,
  transcript_path: 'C:/Users/user/project/.claude/projects/p/session-1.jsonl',
  cwd: 'C:/Users/user/project',
  permission_mode: 'default',
};

export const payloads = {
  sessionStart: () => ({ ...BASE, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-4-7' }),
  prompt: (text = 'do the thing') => ({ ...BASE, hook_event_name: 'UserPromptSubmit', prompt: text }),
  preToolUse: (toolUseId: string, extra: Record<string, unknown> = {}) => ({
    ...BASE,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: toolUseId,
    ...extra,
  }),
  postToolUse: (toolUseId: string, extra: Record<string, unknown> = {}) => ({
    ...BASE,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: toolUseId,
    ...extra,
  }),
  postToolUseFailure: (toolUseId: string, extra: Record<string, unknown> = {}) => ({
    ...BASE,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: toolUseId,
    error: 'Exit code 1',
    is_interrupt: false,
    ...extra,
  }),
  permissionDenied: (toolUseId: string, extra: Record<string, unknown> = {}) => ({
    ...BASE,
    hook_event_name: 'PermissionDenied',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_use_id: toolUseId,
    reason: 'denied',
    ...extra,
  }),
  notification: (type = 'permission_prompt') => ({
    ...BASE,
    hook_event_name: 'Notification',
    message: 'Claude needs your permission to use PowerShell',
    notification_type: type,
  }),
  permission: (extra: Record<string, unknown> = {}) => ({
    ...BASE,
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm view zod version', description: 'Check the zod version' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm view *' }] }],
    ...extra,
  }),
  ask: (
    toolUseId: string,
    questions: unknown[] = [
      {
        question: 'Which color?',
        header: 'Color',
        options: [
          { label: 'Red', description: 'warm' },
          { label: 'Blue', description: 'cool' },
        ],
        multiSelect: false,
      },
    ],
  ) => ({
    ...BASE,
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions },
    tool_use_id: toolUseId,
  }),
  stop: (active = false) => ({
    ...BASE,
    hook_event_name: 'Stop',
    stop_hook_active: active,
    last_assistant_message: 'done',
    background_tasks: [],
  }),
  subagentStart: (agentId: string) => ({
    ...BASE,
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: 'Explore',
  }),
  subagentStop: (agentId: string) => ({
    ...BASE,
    hook_event_name: 'SubagentStop',
    agent_id: agentId,
    agent_type: 'Explore',
    stop_hook_active: false,
    last_assistant_message: 'found it',
  }),
  sessionEnd: () => ({ ...BASE, hook_event_name: 'SessionEnd', reason: 'other' }),
};

export interface HookOutcome {
  fx: BrokerEffects;
  /** The hold started, if any. */
  held: HeldEntry | null;
  /** The events normalized from the payload. */
  normalized: HuddleEvent[];
}

export class BrokerSim {
  state: ReducerState = initialState();
  held: HeldEntry[] = [];
  log: HuddleEvent[] = [];
  /** What each released hold was answered with, by holdId. */
  answers = new Map<string, HookReplyDecision>();
  now = T0;
  questionHoldSeconds = 120;
  huddleStartedAt: number | null = T0 - 60_000;
  ruleDecision: RuleHook | undefined;
  /** RunHost.isAlive stand-in; undefined: no run is live. */
  runLive: ((runId: string) => boolean) | undefined;
  private n = 0;

  ctx(): BrokerCtx {
    return {
      now: this.now,
      nextId: () => {
        this.n += 1;
        return `id-${String(this.n).padStart(4, '0')}`;
      },
    };
  }

  view(): BrokerView {
    return {
      state: this.state,
      held: [...this.held],
      questionHoldSeconds: this.questionHoldSeconds,
      timeouts: { permissionRequest: TIMEOUT_MS, preToolUse: TIMEOUT_MS },
      huddleStartedAt: this.huddleStartedAt,
      ...(this.ruleDecision !== undefined ? { ruleDecision: this.ruleDecision } : {}),
      ...(this.runLive !== undefined ? { runLive: this.runLive } : {}),
    };
  }

  feed(events: readonly HuddleEvent[]): void {
    for (const e of events) {
      this.state = reduce(this.state, e);
      this.log.push(e);
    }
  }

  /** Applies effects as the runtime does. Returns the effects. */
  apply(fx: BrokerEffects): BrokerEffects {
    this.feed(fx.events);
    for (const r of fx.releases) {
      const index = this.held.findIndex((h) => h.holdId === r.holdId);
      if (index < 0) continue;
      this.held.splice(index, 1);
      this.answers.set(r.holdId, r.reply);
      this.feed(r.events);
    }
    return fx;
  }

  run(input: BrokerInput): BrokerEffects {
    return this.apply(decide(this.view(), input, this.ctx()));
  }

  /** A hook arrives now: normalize and reduce it, then ask the broker. A planned hold starts at once. */
  post(payload: Record<string, unknown>): HookOutcome {
    const parsed = parseHookPayload(payload);
    if (!parsed.ok) throw new Error(parsed.error);
    const before = this.state;
    const normalized = normalizeHook(parsed, {
      receivedAt: new Date(this.now).toISOString(),
      nextId: this.ctx().nextId,
      holdTimeouts: { PreToolUse: TIMEOUT_MS / 1000, PermissionRequest: TIMEOUT_MS / 1000 },
    });
    this.feed(normalized);
    this.feed(droppedByEnd(before, this.state, normalized, this.ctx()));
    const approval = normalized.find((e) => e.type === 'approval.requested');
    const question = normalized.find((e) => e.type === 'question.asked');
    const fx = this.run({
      type: 'hook',
      facts: hookFacts(parsed),
      receivedAt: this.now,
      approvalRequestId: approval?.type === 'approval.requested' ? approval.request.requestId : null,
      questionRequestId: question?.type === 'question.asked' ? question.request.requestId : null,
    });
    let held: HeldEntry | null = null;
    if (fx.hold !== null) {
      held = fx.hold.entry;
      this.held.push(held);
      this.feed(fx.hold.events);
    }
    return { fx, held, normalized };
  }

  command(command: BrokerCommand): BrokerEffects {
    return this.run({ type: 'command', command });
  }

  /** Claude Code closed the request, or the server released it on shutdown. */
  close(holdId: string, why: 'closed_by_claude_code' | 'shutdown'): BrokerEffects {
    const fx = decide(this.view(), { type: 'closed', holdId, why }, this.ctx());
    this.held = this.held.filter((h) => h.holdId !== holdId);
    return this.apply(fx);
  }

  timer(holdId: string, kind: 'question_window' | 'hold_limit'): BrokerEffects {
    return this.run({ type: 'timer', holdId, kind });
  }

  /** Events of one type written so far. */
  ofType<T extends HuddleEvent['type']>(type: T): Extract<HuddleEvent, { type: T }>[] {
    return this.log.filter((e): e is Extract<HuddleEvent, { type: T }> => e.type === type);
  }

  /** Start a session with one prompt: the main agent is known and working. */
  startSession(): this {
    this.post(payloads.sessionStart());
    this.post(payloads.prompt());
    return this;
  }
}
