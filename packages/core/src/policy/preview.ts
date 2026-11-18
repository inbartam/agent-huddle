/**
 * "What would this rule have matched?" (F18, `policy.preview` on `huddle:query`). Pure.
 *
 * Looks at the newest approval requests in the events it is given and counts those the rule matches. The events carry
 * only the stored input, which was clipped and masked when it was written, so the answer is approximate and says so
 * (`approximate: true`): an allow never matches a clipped or masked sample here either, exactly as it never would
 * live. The rule is checked on its own, as if enabled, whatever its scope; precedence against other rules and the
 * attached-session setting are not part of the preview.
 */
import {
  agentKey,
  type AgentNode,
  type HuddleEvent,
  type PolicyPreview,
  type PolicyPreviewSample,
  type PolicyRule,
} from '@huddle/shared';
import { storedPolicyFacts } from '../normalize/hook-facts.js';
import { policyInputOf } from './decide.js';
import { ruleMatches } from './rules.js';

/** How many recent requests a preview looks at. */
export const PREVIEW_EXAMINE_MAX = 200;
/** How many matches it returns as samples. */
export const PREVIEW_SAMPLES_MAX = 5;

/** Claude Code's own question box arrives as a PermissionRequest too; it is never an approval (reduce.ts). */
const QUESTION_BOX_TOOL = 'AskUserQuestion';

export function previewRule(
  rule: PolicyRule,
  events: Iterable<HuddleEvent>,
  agents: Readonly<Record<string, AgentNode>>,
  limits: { examine?: number; samples?: number } = {},
): PolicyPreview {
  const examineMax = limits.examine ?? PREVIEW_EXAMINE_MAX;
  const samplesMax = limits.samples ?? PREVIEW_SAMPLES_MAX;
  const requests: Extract<HuddleEvent, { type: 'approval.requested' }>[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== 'approval.requested' || e.request.toolName === QUESTION_BOX_TOOL) continue;
    if (seen.has(e.request.requestId)) continue;
    seen.add(e.request.requestId);
    requests.push(e);
  }
  requests.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  const examined = requests.slice(0, Math.max(0, examineMax));
  const asEnabled: PolicyRule = { ...rule, enabled: true };
  let matched = 0;
  const samples: PolicyPreviewSample[] = [];
  for (const e of examined) {
    const request = e.request;
    const node = Object.hasOwn(agents, request.agentKey) ? agents[request.agentKey] : undefined;
    // The stored request has no payload cwd: the agent's (else its root's) stands in; the trusted folder is the root's.
    const rootKey = agentKey(e.sessionId);
    const root = Object.hasOwn(agents, rootKey) ? agents[rootKey] : undefined;
    const sessionCwd = root?.sessionCwd ?? null;
    const facts = storedPolicyFacts(request.toolName, request.toolInput, node?.cwd ?? root?.cwd ?? null);
    const input = policyInputOf(
      facts,
      { role: node?.role ?? '', origin: node?.origin ?? 'attached', cwd: node?.cwd ?? null },
      sessionCwd,
    );
    if (!ruleMatches(asEnabled, input)) continue;
    matched += 1;
    if (samples.length < samplesMax) {
      samples.push({
        agentKey: request.agentKey,
        toolName: request.toolName,
        summary: request.summary,
        receivedAt: request.receivedAt,
      });
    }
  }
  return { examined: examined.length, matched, samples, approximate: true };
}
