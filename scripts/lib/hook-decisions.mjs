// Pure decision helpers for the hook experiments. No clock, no I/O.
// Each returns a hook response body, or null for "no decision" (Claude Code carries on as usual).
//   nudgeDecision        S7a  additionalContext note on the next PreToolUse
//   stopFollowup         S7b  continue the turn once with a follow-up message
//   answerQuestions      S5   answer AskUserQuestion from a hook
//   shouldHoldPreToolUse S6   which PreToolUse calls the pause experiment holds

export const NUDGE_PREFIX = 'Note from the user via Agent Huddle: ';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** S7a: one additionalContext note per session, on its next PreToolUse. */
export function nudgeDecision(payload, text, delivered) {
  if (!isObject(payload) || payload.hook_event_name !== 'PreToolUse') return null;
  const sid = String(payload.session_id);
  if (delivered.has(sid)) return null;
  delivered.add(sid);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: NUDGE_PREFIX + text } };
}

/** S7b: block the first Stop of a session with a follow-up; never block a Stop that a hook already continued. */
export function stopFollowup(payload, text, delivered) {
  if (!isObject(payload) || payload.hook_event_name !== 'Stop' || payload.stop_hook_active === true) return null;
  const sid = String(payload.session_id);
  if (delivered.has(sid)) return null;
  delivered.add(sid);
  return { decision: 'block', reason: text };
}

/** S5: answer every question with its first option, only when the input has the shape we expect. */
export function answerQuestions(payload) {
  if (!isObject(payload) || payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'AskUserQuestion') return null;
  const input = payload.tool_input;
  if (!isObject(input) || !Array.isArray(input.questions) || input.questions.length === 0) return null;
  const answers = {};
  for (const q of input.questions) {
    if (!isObject(q) || typeof q.question !== 'string' || !Array.isArray(q.options) || q.options.length === 0) return null;
    // Multi-select needs a list answer, and repeated question text would leave one question unanswered: no decision.
    if (q.multiSelect === true || Object.hasOwn(answers, q.question)) return null;
    const first = q.options[0];
    if (!isObject(first) || typeof first.label !== 'string') return null;
    answers[q.question] = first.label;
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, answers } } };
}

/**
 * S14b: answer AskUserQuestion with a caller-supplied answers object, passed through unchanged (any JSON value per question),
 * so the answer format for multi-select and free text can be tried by hand. Same shape check as answerQuestions, minus the
 * multi-select limit. Returns null for anything that is not a well-formed AskUserQuestion call.
 */
export function answerQuestionsWith(payload, answers) {
  if (!isObject(payload) || payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'AskUserQuestion') return null;
  const input = payload.tool_input;
  if (!isObject(input) || !Array.isArray(input.questions) || input.questions.length === 0 || !isObject(answers)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, answers } } };
}

/** S6: hold PreToolUse calls, optionally only for sessions whose id starts with a prefix. */
export function shouldHoldPreToolUse(payload, sessionPrefix) {
  if (!isObject(payload) || payload.hook_event_name !== 'PreToolUse') return false;
  return sessionPrefix === undefined || String(payload.session_id).startsWith(sessionPrefix);
}
