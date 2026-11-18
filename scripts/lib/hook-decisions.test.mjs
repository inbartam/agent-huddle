import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeDecision, stopFollowup, answerQuestions, answerQuestionsWith, shouldHoldPreToolUse } from './hook-decisions.mjs';

const pre = (session_id, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id, tool_name: 'Read', tool_input: {}, ...extra });

test('nudgeDecision delivers once per session', () => {
  const delivered = new Set();
  const first = nudgeDecision(pre('s1'), 'hello', delivered);
  assert.equal(first.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.ok(first.hookSpecificOutput.additionalContext.startsWith('Note from the user via Agent Huddle: '));
  assert.ok(first.hookSpecificOutput.additionalContext.endsWith('hello'));
  assert.equal(nudgeDecision(pre('s1'), 'hello', delivered), null);
  assert.notEqual(nudgeDecision(pre('s2'), 'hello', delivered), null);
});

test('nudgeDecision ignores non-PreToolUse', () => {
  assert.equal(nudgeDecision({ hook_event_name: 'PostToolUse', session_id: 's1' }, 'x', new Set()), null);
});

test('stopFollowup blocks first Stop', () => {
  const delivered = new Set();
  const stop = { hook_event_name: 'Stop', session_id: 's1', stop_hook_active: false };
  assert.deepEqual(stopFollowup(stop, 'check the README too', delivered), { decision: 'block', reason: 'check the README too' });
  assert.equal(stopFollowup(stop, 'check the README too', delivered), null);
});

test('stopFollowup skips when stop_hook_active', () => {
  assert.equal(stopFollowup({ hook_event_name: 'Stop', session_id: 's9', stop_hook_active: true }, 'x', new Set()), null);
});

test('answerQuestions picks first option', () => {
  const questions = [{ question: 'Which DB?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }];
  const out = answerQuestions(pre('s1', { tool_name: 'AskUserQuestion', tool_input: { questions } }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(out.hookSpecificOutput.updatedInput.answers, { 'Which DB?': 'SQLite' });
  assert.deepEqual(out.hookSpecificOutput.updatedInput.questions, questions);
});

test('answerQuestions returns null on unexpected shape', () => {
  const ask = (tool_input) => answerQuestions(pre('s1', { tool_name: 'AskUserQuestion', tool_input }));
  assert.equal(ask({}), null);
  assert.equal(ask({ questions: 'x' }), null);
  assert.equal(ask({ questions: [{ question: 'Q', options: [] }] }), null);
  assert.equal(ask(undefined), null);
  assert.equal(answerQuestions(pre('s1', { tool_name: 'Read' })), null);
});

test('answerQuestions returns null for multi-select or repeated question text', () => {
  const ask = (questions) => answerQuestions(pre('s1', { tool_name: 'AskUserQuestion', tool_input: { questions } }));
  assert.equal(ask([{ question: 'Q', multiSelect: true, options: [{ label: 'A' }] }]), null);
  assert.equal(ask([{ question: 'Q', options: [{ label: 'A' }] }, { question: 'Q', options: [{ label: 'Z' }] }]), null);
  assert.notEqual(ask([{ question: 'Q1', options: [{ label: 'A' }] }, { question: 'Q2', options: [{ label: 'B' }] }]), null);
});

test('shouldHoldPreToolUse filters by prefix', () => {
  assert.equal(shouldHoldPreToolUse(pre('abc123'), 'abc'), true);
  assert.equal(shouldHoldPreToolUse(pre('zzz'), 'abc'), false);
  assert.equal(shouldHoldPreToolUse(pre('zzz'), undefined), true);
  assert.equal(shouldHoldPreToolUse({ hook_event_name: 'Stop', session_id: 'abc' }, undefined), false);
});

test('answerQuestionsWith passes the supplied answers through unchanged, including lists for multi-select', () => {
  const questions = [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }];
  const answers = { 'Which?': ['A', 'B'] };
  const out = answerQuestionsWith(pre('s1', { tool_name: 'AskUserQuestion', tool_input: { questions } }), answers);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { questions, answers });
});

test('answerQuestionsWith returns null for other tools, bad input or a non-object answers', () => {
  const questions = [{ question: 'Q', options: [{ label: 'A' }], multiSelect: false }];
  assert.equal(answerQuestionsWith(pre('s1', { tool_name: 'Read', tool_input: { questions } }), { Q: 'A' }), null);
  assert.equal(answerQuestionsWith(pre('s1', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }), { Q: 'A' }), null);
  assert.equal(answerQuestionsWith(pre('s1', { tool_name: 'AskUserQuestion', tool_input: { questions } }), 'A'), null);
});
