import { describe, expect, it } from 'vitest';
import { CONTROL_REASONS, agentKey, questionIsAmbiguous } from '@huddle/shared';
import { questionItemId } from '../state/reduce.js';
import { BrokerSim, payloads, T0, TIMEOUT_MS } from '../test/broker-sim.js';
import { SELF_RELEASE_MARGIN_MS } from './model.js';

function heldQuestion(questions?: unknown[]) {
  const sim = new BrokerSim().startSession();
  const out = sim.post(payloads.ask('tu-q1', questions));
  if (out.held === null) throw new Error('not held');
  return { sim, held: out.held, fx: out.fx };
}

const item = (sim: BrokerSim) => sim.state.inbox.find((i) => i.id === questionItemId('tu-q1'));

describe('AskUserQuestion is held for the question window (F11)', () => {
  it('holds with the tool_use_id as request id, until receivedAt + questionHoldSeconds', () => {
    const { held, fx, sim } = heldQuestion();
    expect(held).toMatchObject({
      kind: 'question',
      requestId: 'tu-q1',
      toolUseId: 'tu-q1',
      timeoutAt: T0 + TIMEOUT_MS,
    });
    expect(fx.hold?.timers).toEqual([{ at: T0 + 120_000, kind: 'question_window' }]);
    expect(item(sim)?.question?.expiresAt).toBe(T0 + TIMEOUT_MS);
  });

  it('the window never runs past the hook timeout minus the margin', () => {
    const sim = new BrokerSim().startSession();
    sim.questionHoldSeconds = 600; // above the settings cap (590), to prove the clamp
    expect(sim.post(payloads.ask('tu-q1')).fx.hold?.timers).toEqual([
      { at: T0 + TIMEOUT_MS - SELF_RELEASE_MARGIN_MS, kind: 'question_window' },
    ]);
  });

  it('window 0: not held; the inbox item closes passed_through so the Huddle does not offer an answer', () => {
    const sim = new BrokerSim().startSession();
    sim.questionHoldSeconds = 0;
    const { held, fx } = sim.post(payloads.ask('tu-q1'));
    expect(held).toBeNull();
    expect(fx.reply).toEqual({ kind: 'none' });
    expect(sim.ofType('question.closed')).toEqual([
      expect.objectContaining({ requestId: 'tu-q1', outcome: 'passed_through' }),
    ]);
    expect(item(sim)?.resolvedAt).not.toBeNull();
  });

  it('an unreadable AskUserQuestion input is not held (no question.asked)', () => {
    const sim = new BrokerSim().startSession();
    const { held, fx } = sim.post(payloads.ask('tu-q1', [{ options: [] }]));
    expect(held).toBeNull();
    expect(fx.reply).toEqual({ kind: 'none' });
  });

  it('a second post for a question already held is not held; the first hold and its item stay', () => {
    const { sim, held } = heldQuestion();
    const again = sim.post(payloads.ask('tu-q1'));
    expect(again.held).toBeNull();
    expect(again.fx.reply).toEqual({ kind: 'none' });
    expect(sim.held).toEqual([held]);
    expect(item(sim)?.resolvedAt).toBeNull();
    expect(sim.ofType('question.closed')).toEqual([]);
  });

  it('a question of an unknown subagent is not held', () => {
    const sim = new BrokerSim().startSession();
    const { held } = sim.post({ ...payloads.ask('tu-q1'), agent_id: 'ghost' });
    expect(held).toBeNull();
  });
});

describe('question.answer', () => {
  it('answers from the raw payload (exact text and label) and records the display answer', () => {
    const secret = `sk-ant-api03-${'a'.repeat(40)}`;
    const { sim, held } = heldQuestion([
      { question: `Use key ${secret}?`, options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
    ]);
    const shown = item(sim)?.question?.questions[0];
    if (!shown) throw new Error('no display question');
    expect(shown.question).not.toContain(secret);
    const fx = sim.command({ type: 'question.answer', requestId: 'tu-q1', answers: { [shown.question]: 'Yes' } });
    expect(fx.result).toEqual({ ok: true });
    const reply = sim.answers.get(held.holdId);
    expect(reply).toEqual({
      kind: 'preToolUse.answer',
      toolInput: {
        questions: [
          { question: `Use key ${secret}?`, options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
        ],
      },
      answers: { [`Use key ${secret}?`]: 'Yes' },
    });
    // The log keeps the masked display words only.
    expect(sim.ofType('question.answered')).toEqual([
      expect.objectContaining({ requestId: 'tu-q1', answers: { [shown.question]: 'Yes' }, source: 'user' }),
    ]);
    expect(JSON.stringify(sim.log)).not.toContain(secret);
    expect(item(sim)?.resolvedAt).toBe(T0);
  });

  it('accepts a one-element array and the raw question text as key', () => {
    const { sim, held } = heldQuestion();
    sim.command({ type: 'question.answer', requestId: 'tu-q1', answers: { 'Which color?': ['Blue'] } });
    const reply = sim.answers.get(held.holdId);
    expect(reply?.kind === 'preToolUse.answer' ? reply.answers : null).toEqual({ 'Which color?': 'Blue' });
  });

  it('rejects a missing or unknown option, and nothing is sent', () => {
    const { sim } = heldQuestion();
    expect(sim.command({ type: 'question.answer', requestId: 'tu-q1', answers: {} }).result).toMatchObject({
      code: 'invalid',
    });
    expect(
      sim.command({ type: 'question.answer', requestId: 'tu-q1', answers: { 'Which color?': 'Green' } }).result,
    ).toMatchObject({ code: 'invalid' });
    expect(sim.held).toHaveLength(1);
  });

  it('multi-select: labels in option order joined with ", " (S14 b), typed words after them, masked in the log', () => {
    const secret = `sk-ant-api03-${'b'.repeat(40)}`;
    const { sim, held } = heldQuestion([
      {
        question: 'Which checks?',
        options: [{ label: 'Lint' }, { label: 'Tests' }, { label: 'Types' }],
        multiSelect: true,
      },
    ]);
    const fx = sim.command({
      type: 'question.answer',
      requestId: 'tu-q1',
      answers: { 'Which checks?': ['Types', 'Lint'] },
      other: { 'Which checks?': `also e2e ${secret}` },
    });
    expect(fx.result).toEqual({ ok: true });
    const reply = sim.answers.get(held.holdId);
    expect(reply?.kind === 'preToolUse.answer' ? reply.answers : null).toEqual({
      'Which checks?': `Lint, Types, also e2e ${secret}`,
    });
    const logged = sim.ofType('question.answered')[0]?.answers['Which checks?'];
    expect(String(logged).startsWith('Lint, Types, also e2e ')).toBe(true);
    expect(JSON.stringify(sim.log)).not.toContain(secret);
  });

  it('single-select: typed words instead of an option; not both, not two options, not nothing', () => {
    const typed = heldQuestion();
    expect(
      typed.sim.command({
        type: 'question.answer',
        requestId: 'tu-q1',
        answers: {},
        other: { 'Which color?': ' Teal ' },
      }).result,
    ).toEqual({ ok: true });
    const reply = typed.sim.answers.get(typed.held.holdId);
    expect(reply?.kind === 'preToolUse.answer' ? reply.answers : null).toEqual({ 'Which color?': 'Teal' });
    // The older one-field form still works for a one-question call.
    const legacy = heldQuestion();
    expect(
      legacy.sim.command({ type: 'question.answer', requestId: 'tu-q1', answers: {}, freeText: 'Purple' }).result,
    ).toEqual({ ok: true });
    const bads: { answers: Record<string, string | string[]>; other?: Record<string, string> }[] = [
      { answers: { 'Which color?': 'Red' }, other: { 'Which color?': 'Teal' } },
      { answers: { 'Which color?': ['Red', 'Blue'] } },
      { answers: {}, other: { 'Which color?': '   ' } },
    ];
    for (const bad of bads) {
      const { sim } = heldQuestion();
      expect(sim.command({ type: 'question.answer', requestId: 'tu-q1', ...bad }).result).toMatchObject({
        code: 'invalid',
      });
      expect(sim.held).toHaveLength(1);
    }
  });

  it('options that look the same once clipped are answered in the terminal; nothing is sent and the hold stays', () => {
    const long = 'x'.repeat(400);
    const { sim, held } = heldQuestion([
      { question: 'Which file?', options: [{ label: `${long}-a` }, { label: `${long}-b` }], multiSelect: false },
    ]);
    const shown = item(sim)?.question;
    if (!shown) throw new Error('no display question');
    const [first, second] = shown.questions[0]?.options ?? [];
    expect(first?.label).toBe(second?.label);
    const fx = sim.command({
      type: 'question.answer',
      requestId: 'tu-q1',
      answers: { 'Which file?': second?.label ?? '' },
    });
    expect(fx.result).toEqual({ ok: false, code: 'unsupported', message: CONTROL_REASONS.ambiguousChoice });
    expect(sim.answers.has(held.holdId)).toBe(false);
    expect(sim.held).toHaveLength(1);
    // "Answer in terminal" still works.
    expect(sim.command({ type: 'approval.passThrough', requestId: 'tu-q1' }).result).toEqual({ ok: true });
  });

  it('multi-select with a label holding ", " is answered in the terminal (the joined answer could read as two)', () => {
    const { sim, held } = heldQuestion([
      {
        question: 'What next?',
        options: [{ label: 'Yes, delete it' }, { label: 'Keep backups' }],
        multiSelect: true,
      },
    ]);
    const fx = sim.command({
      type: 'question.answer',
      requestId: 'tu-q1',
      answers: { 'What next?': ['Keep backups'] },
    });
    expect(fx.result).toEqual({ ok: false, code: 'unsupported', message: CONTROL_REASONS.ambiguousChoice });
    expect(sim.answers.has(held.holdId)).toBe(false);
    const shown = item(sim)?.question;
    if (!shown) throw new Error('no display question');
    expect(questionIsAmbiguous(shown)).toBe(true);
  });

  it('single-select labels may hold ", " (the answer is one label)', () => {
    const { sim } = heldQuestion([
      { question: 'Go?', options: [{ label: 'Yes, now' }, { label: 'No' }], multiSelect: false },
    ]);
    expect(sim.command({ type: 'question.answer', requestId: 'tu-q1', answers: { 'Go?': 'Yes, now' } }).result).toEqual(
      {
        ok: true,
      },
    );
  });

  it('two questions that look the same are answered in the terminal too', () => {
    const long = 'q'.repeat(2100);
    const { sim } = heldQuestion([
      { question: `${long} one?`, options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
      { question: `${long} two?`, options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
    ]);
    const shown = item(sim)?.question?.questions[0]?.question ?? '';
    expect(
      sim.command({ type: 'question.answer', requestId: 'tu-q1', answers: { [shown]: 'Yes' } }).result,
    ).toMatchObject({ code: 'unsupported' });
  });

  it('a second answer is expired; an unknown id is not_found', () => {
    const { sim } = heldQuestion();
    sim.command({ type: 'question.answer', requestId: 'tu-q1', answers: { 'Which color?': 'Red' } });
    expect(
      sim.command({ type: 'question.answer', requestId: 'tu-q1', answers: { 'Which color?': 'Red' } }).result,
    ).toMatchObject({ code: 'expired' });
    expect(sim.command({ type: 'question.answer', requestId: 'zzz', answers: {} }).result).toMatchObject({
      code: 'not_found',
    });
  });
});

describe('question endings', () => {
  it('the window runs out -> no decision, question.closed passed_through (terminal box appears)', () => {
    const { sim, held } = heldQuestion();
    sim.now = T0 + 120_000;
    sim.timer(held.holdId, 'question_window');
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('question.closed')[0]).toMatchObject({ outcome: 'passed_through', source: 'huddle' });
  });

  it('"answer in terminal" (passThrough with the question id) releases early -> passed_through by the user', () => {
    const { sim, held } = heldQuestion();
    expect(sim.command({ type: 'approval.passThrough', requestId: 'tu-q1' }).result).toEqual({ ok: true });
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('question.closed')[0]).toMatchObject({ outcome: 'passed_through', source: 'user' });
    expect(sim.command({ type: 'approval.passThrough', requestId: 'tu-q1' }).result).toMatchObject({ code: 'expired' });
  });

  it('Claude Code closes it early -> answered_elsewhere; at its timeout -> expired', () => {
    const early = heldQuestion();
    early.sim.now = T0 + 5_000;
    early.sim.close(early.held.holdId, 'closed_by_claude_code');
    expect(early.sim.ofType('question.closed')[0]?.outcome).toBe('answered_elsewhere');

    const late = heldQuestion();
    late.sim.now = T0 + TIMEOUT_MS;
    late.sim.close(late.held.holdId, 'closed_by_claude_code');
    expect(late.sim.ofType('question.closed')[0]?.outcome).toBe('expired');
  });

  it('shutdown -> no decision, question.closed shutdown', () => {
    const { sim, held } = heldQuestion();
    sim.run({ type: 'shutdown' });
    expect(sim.answers.get(held.holdId)).toEqual({ kind: 'none' });
    expect(sim.ofType('question.closed')[0]?.outcome).toBe('shutdown');
    expect(sim.state.agents[agentKey('session-1')]?.status).toBe('working');
  });

  it('a refused hold closes the question (passed_through, or shutdown while closing)', () => {
    const sim = new BrokerSim().startSession();
    const { fx } = sim.post(payloads.ask('tu-q1'));
    if (fx.hold === null) throw new Error('no plan');
    sim.held = [];
    sim.run({ type: 'refused', plan: fx.hold, why: 'cap' });
    expect(sim.ofType('question.closed')[0]?.outcome).toBe('passed_through');
  });
});
