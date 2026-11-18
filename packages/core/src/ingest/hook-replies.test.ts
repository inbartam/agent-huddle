import { describe, expect, it } from 'vitest';
import { DENY_PREFIX, hookReply, NOTE_PREFIX } from './hook-replies.js';

/** The proven M0 helpers (S5, S7a, S7b). Plain JS, so typed here by hand. */
interface SpikeDecisions {
  NUDGE_PREFIX: string;
  nudgeDecision: (payload: unknown, text: string, delivered: Set<string>) => unknown;
  stopFollowup: (payload: unknown, text: string, delivered: Set<string>) => unknown;
  answerQuestions: (payload: unknown) => unknown;
}

async function spike(): Promise<SpikeDecisions> {
  const url = new URL('../../../../scripts/lib/hook-decisions.mjs', import.meta.url);
  return (await import(url.href)) as SpikeDecisions;
}

const askInput = {
  questions: [
    {
      question: 'Which database?',
      header: 'DB',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'relational' },
        { label: 'SQLite', description: 'file' },
      ],
    },
  ],
};

describe('hookReply', () => {
  it('no decision is null (an empty 200)', () => {
    expect(hookReply({ kind: 'none' })).toBeNull();
  });

  it('PermissionRequest allow matches the S1 spike shape', () => {
    expect(hookReply({ kind: 'permission.allow' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('PermissionRequest deny carries the message after the attribution prefix (S1), and omits an empty one', () => {
    expect(DENY_PREFIX).toBe('Denied by the user in Agent Huddle. Their message: ');
    expect(hookReply({ kind: 'permission.deny', message: 'Use the staging database instead.' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: 'Denied by the user in Agent Huddle. Their message: Use the staging database instead.',
        },
      },
    });
    expect(hookReply({ kind: 'permission.deny', message: '' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
    expect(hookReply({ kind: 'permission.deny' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
  });

  it('a rule deny (M4, F18) sends its message as is: the user prefix is absent, same S1 shape', () => {
    const message = 'Denied by Agent Huddle rule "No force push" (no-force).';
    const body = hookReply({ kind: 'permission.denyByRule', message });
    expect(body).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
    });
    expect(JSON.stringify(body)).not.toContain(DENY_PREFIX);
    expect(JSON.stringify(body)).not.toContain('Denied by the user');
    expect(hookReply({ kind: 'permission.denyByRule', message: '' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
  });

  it('AskUserQuestion answer equals what the S5 spike sent', async () => {
    const { answerQuestions } = await spike();
    const payload = {
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: askInput,
    };
    const fromSpike = answerQuestions(payload);
    const ours = hookReply({
      kind: 'preToolUse.answer',
      toolInput: askInput,
      answers: { 'Which database?': 'Postgres' },
    });
    expect(ours).toEqual(fromSpike);
    expect(ours).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...askInput, answers: { 'Which database?': 'Postgres' } },
      },
    });
  });

  it('does not mutate the tool input it spreads', () => {
    const input = { questions: [], answers: { old: 'x' } };
    const answers = { q: 'a' };
    hookReply({ kind: 'preToolUse.answer', toolInput: input, answers });
    expect(input).toEqual({ questions: [], answers: { old: 'x' } });
    expect(answers).toEqual({ q: 'a' });
  });

  it('PreToolUse note equals what the S7a spike sent, with the same prefix', async () => {
    const { nudgeDecision, NUDGE_PREFIX } = await spike();
    expect(NOTE_PREFIX).toBe(NUDGE_PREFIX);
    expect(NOTE_PREFIX).toBe('Note from the user via Agent Huddle: ');
    const fromSpike = nudgeDecision(
      { session_id: 's1', hook_event_name: 'PreToolUse' },
      'run the tests first',
      new Set(),
    );
    const ours = hookReply({ kind: 'preToolUse.note', text: 'run the tests first' });
    expect(ours).toEqual(fromSpike);
    expect(ours).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'Note from the user via Agent Huddle: run the tests first',
      },
    });
  });

  it('Stop block equals what the S7b spike sent', async () => {
    const { stopFollowup } = await spike();
    const fromSpike = stopFollowup({ session_id: 's1', hook_event_name: 'Stop' }, 'also update the README', new Set());
    const ours = hookReply({ kind: 'stop.block', reason: 'also update the README' });
    expect(ours).toEqual(fromSpike);
    expect(ours).toEqual({ decision: 'block', reason: 'also update the README' });
  });

  it('every reply is plain JSON (survives a round trip unchanged)', () => {
    const replies = [
      hookReply({ kind: 'permission.allow' }),
      hookReply({ kind: 'permission.deny', message: 'no "quotes" \n here' }),
      hookReply({ kind: 'preToolUse.answer', toolInput: askInput, answers: { 'Which database?': 'SQLite' } }),
      hookReply({ kind: 'preToolUse.note', text: 'ünïcode ✓' }),
      hookReply({ kind: 'stop.block', reason: 'keep going' }),
    ];
    for (const reply of replies) expect(JSON.parse(JSON.stringify(reply))).toEqual(reply);
  });
});
