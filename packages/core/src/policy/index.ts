/** Approval rules (M4, F18, ADR-020 §3): pure matching, the default set, the decision and the preview. */
export {
  evaluate,
  ruleMatches,
  isPlainCommand,
  compileGlob,
  shellOf,
  FILE_TOOLS,
  type PolicyAction,
  type PolicyInput,
  type PolicyVerdict,
} from './rules.js';
export { DEFAULT_POLICY_RULES, defaultPolicyRules } from './defaults.js';
export { decideByPolicy, policyInputOf, ruleDenyMessage, rulesApplyTo, type PolicyOutcome } from './decide.js';
export { previewRule, PREVIEW_EXAMINE_MAX, PREVIEW_SAMPLES_MAX } from './preview.js';
