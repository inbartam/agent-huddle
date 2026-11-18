/**
 * From the rules' verdict to what the broker does with a permission request (F18, ADR-020 §3). Pure.
 *
 * Scope: rules apply to managed sessions (launched by the Huddle) while their run is live, and to attached sessions
 * (and managed ones whose run has ended) only when the user
 * turned on `settings.policy.applyToAttached` (default off until spike S15 shows what a late answer does after the
 * terminal prompt was answered). With the Huddle closed nothing listens, so no rule applies at all.
 *
 * A deny tells the agent which rule refused, in the Huddle's own words: never the user's `DENY_PREFIX`, because the
 * user did not write it.
 */
import { CLIP_LIMITS, type AgentOrigin, type PolicyRule, type PolicySettings } from '@huddle/shared';
import { evaluate, type PolicyAction, type PolicyInput } from './rules.js';

export interface PolicyOutcome {
  decision: PolicyAction;
  ruleId: string;
  ruleName: string;
  /** For a deny: what the agent reads. Null otherwise. */
  message: string | null;
}

/**
 * Do the rules apply to a session of this origin? A managed session counts as managed only while its run is live
 * (`runLive`, supplied by the core: no `run.exited` on its root and `RunHost.isAlive`). A managed root resumed in a
 * terminal (`claude --resume <runId>`) keeps its `managed` origin but is an interactive session, so it is treated as
 * attached (security review 2026-11-14, L1).
 */
export function rulesApplyTo(origin: AgentOrigin, settings: PolicySettings, runLive: boolean): boolean {
  return (origin === 'managed' && runLive) || settings.applyToAttached;
}

// eslint-disable-next-line no-control-regex -- control characters (and quotes) are removed from the name
const NAME_NOISE = /[\u0000-\u001f\u007f-\u009f"]+/g;

/** One line, no control characters, bounded: the rule name as the agent reads it. */
function plainName(name: string): string {
  const flat = name.replace(NAME_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

/** The message an agent reads when a rule denies its tool call. */
export function ruleDenyMessage(rule: { id: string; name: string }): string {
  const id = rule.id.length > CLIP_LIMITS.id ? rule.id.slice(0, CLIP_LIMITS.id) : rule.id;
  return `Denied by Agent Huddle rule "${plainName(rule.name)}" (${id}).`;
}

/**
 * The raw request facts plus what the reducer knows of the agent. `cwd` is where the request says the agent is (the
 * payload's, else the node's; untrusted). `sessionCwd` is the trusted session folder: the root node's `sessionCwd`
 * (`AgentNode.sessionCwd`), passed by the caller because a subagent's node does not carry it.
 */
export function policyInputOf(
  facts: Omit<PolicyInput, 'role' | 'origin' | 'sessionCwd'>,
  node: { role: string; origin: AgentOrigin; cwd: string | null },
  sessionCwd: string | null,
): PolicyInput {
  return {
    ...facts,
    cwd: facts.cwd ?? node.cwd,
    sessionCwd,
    role: node.role === '' ? null : node.role,
    origin: node.origin,
  };
}

/**
 * What the rules decide for this request, or null when they do not apply or none matches. `runLive`: the session's
 * managed run is live right now (see `rulesApplyTo`).
 */
export function decideByPolicy(
  rules: readonly PolicyRule[],
  settings: PolicySettings,
  input: PolicyInput,
  runLive: boolean,
): PolicyOutcome | null {
  if (!rulesApplyTo(input.origin, settings, runLive)) return null;
  const verdict = evaluate(rules, input);
  if (verdict === null) return null;
  return {
    decision: verdict.action,
    ruleId: verdict.ruleId,
    ruleName: verdict.ruleName,
    message: verdict.action === 'deny' ? ruleDenyMessage({ id: verdict.ruleId, name: verdict.ruleName }) : null,
  };
}
