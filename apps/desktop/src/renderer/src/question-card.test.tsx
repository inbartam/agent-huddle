/**
 * Question cards (M3, F11): single-select options are buttons that send `question.answer` with the exact label;
 * multi-select questions are check boxes, every question has an Other field for typed words (S14 b); "Answer in terminal" is there for all; after answering the card says what Huddle answered.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTROL_REASONS, type HuddleEvent, type QuestionRequest } from '@huddle/shared';
import { InboxCard } from './components/Inbox.js';
import { IK, interactState, MULTI, NOW, questionItem, SINGLE } from './testing/interact-fixture.js';
import { settled } from './testing/arming.js';
import { SESSION, T0 } from './testing/fixture.js';
import {
  answersCommand,
  itemControls,
  itemEnding,
  passThroughCommand,
  pickComplete,
  pickSummary,
  questionHasPicks,
  questionLimit,
  questionTerminalControl,
  togglePick,
  typePick,
} from './view/inbox.js';

const ok = () => Promise.resolve({ ok: true as const });

function card(request: QuestionRequest, extra: Partial<Parameters<typeof InboxCard>[0]> = {}) {
  const item = extra.item ?? questionItem(request);
  return renderToStaticMarkup(
    settled(<InboxCard state={interactState()} item={item} renames={new Map()} onCommand={ok} now={NOW} {...extra} />),
  );
}

function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>.*?<\/button>/gs)].map((m) => m[0]);
}

describe('single-select question', () => {
  it('shows the header, the question and each option as an enabled button with its number key', () => {
    const html = card(SINGLE);
    expect(html).toContain('Tone');
    expect(html).toContain('Which tone should the notes use?');
    const options = buttons(html).filter((b) => b.includes('class="control control-plain option'));
    expect(options).toHaveLength(3);
    for (const b of options) expect(b).not.toContain('aria-disabled');
    expect(options[0]).toContain('aria-keyshortcuts="1"');
    expect(options[0]).toContain('Short sentences');
  });

  it('offers Answer in terminal (a pass-through) and says when the terminal takes over, as an estimate', () => {
    const html = card(SINGLE);
    const terminal = buttons(html).find((b) => b.includes('Answer in terminal'));
    expect(terminal).toBeDefined();
    expect(terminal).not.toContain('aria-disabled');
    expect(passThroughCommand('q-1')).toEqual({ type: 'approval.passThrough', requestId: 'q-1' });
    // Received at T0+10 s, held 120 s by default: 70 s left at NOW (T0+60 s).
    expect(questionLimit(interactState(), questionItem(SINGLE), NOW).text).toBe('terminal in ~1:10, est.');
    expect(html).toContain('terminal in ~1:10, est.');
  });
});

describe('several choices or a typed answer (S14 b)', () => {
  it('multi-select: options are check boxes with a hint, an Other field, and Send waits for a pick', () => {
    const html = card(MULTI);
    expect(html).not.toContain('options-readonly');
    expect(html).toContain('Choose any that apply.');
    const options = buttons(html).filter((b) => b.includes('option is-multi'));
    expect(options.length).toBeGreaterThan(1);
    for (const b of options) expect(b).not.toContain('aria-disabled');
    expect(html).toContain('class="question-other"');
    expect(html).toContain('Other: add your own words (optional)');
    const send = buttons(html).find((b) => b.includes('>Send'));
    expect(send).toContain('aria-disabled="true"');
    expect(html).not.toContain(CONTROL_REASONS.multiSelectOrText);
    expect(questionHasPicks(MULTI.questions)).toBe(true);
  });

  it('a question with no options is a typed answer', () => {
    const typed: QuestionRequest = {
      ...SINGLE,
      requestId: 'q-3',
      questions: [{ question: 'What should the title be?', multiSelect: false, options: [] }],
    };
    const html = card(typed);
    expect(html).toContain('placeholder="Type your answer"');
    expect(html).not.toContain(CONTROL_REASONS.multiSelectOrText);
  });

  it('picks: multi-select toggles in option order, single-select is one or the other, typed words follow labels', () => {
    const multi = MULTI.questions[0];
    const single = SINGLE.questions[0];
    if (!multi || !single) throw new Error('fixture');
    const [a, b] = multi.options.map((o) => o.label);
    if (a === undefined || b === undefined) throw new Error('fixture');
    let p = togglePick(multi, undefined, b);
    p = togglePick(multi, p, a);
    expect(p.labels).toEqual([a, b]);
    expect(togglePick(multi, p, a).labels).toEqual([b]);
    p = typePick(multi, p, 'mine');
    expect(p).toEqual({ labels: [a, b], typed: 'mine' });
    expect(pickSummary([p])).toBe(`${a}, ${b}, mine`);
    const s = typePick(single, togglePick(single, undefined, 'Friendly'), 'Warm');
    expect(s).toEqual({ labels: [], typed: 'Warm' });
    expect(togglePick(single, s, 'Friendly')).toEqual({ labels: ['Friendly'], typed: '' });
    expect(pickComplete({ labels: [], typed: '  ' })).toBe(false);
    expect(answersCommand('q-2', [{ question: multi, pick: p }])).toEqual({
      type: 'question.answer',
      requestId: 'q-2',
      answers: { [multi.question]: [a, b] },
      other: { [multi.question]: 'mine' },
    });
    expect(answersCommand('q-1', [{ question: single, pick: { labels: ['Friendly'], typed: '' } }])).toEqual({
      type: 'question.answer',
      requestId: 'q-1',
      answers: { [single.question]: 'Friendly' },
    });
  });

  it('keeps Answer in terminal off when not connected', () => {
    const state = interactState({ connection: undefined });
    const c = questionTerminalControl(itemControls(state, questionItem(MULTI)));
    expect(c).toEqual({ enabled: false, reason: CONTROL_REASONS.notConnected });
  });
});

describe('after answering', () => {
  it('shows what Huddle answered, as the terminal will show it', () => {
    const item = questionItem(SINGLE, { resolvedAt: T0 + 30_000 });
    const events: HuddleEvent[] = [
      {
        id: 'e1',
        ts: T0 + 30_000,
        sessionId: SESSION,
        agentKey: IK.asker,
        source: 'user',
        type: 'question.answered',
        requestId: 'q-1',
        answers: { 'Which tone should the notes use?': 'Plain' },
      },
    ];
    expect(itemEnding(item, events)?.answered).toEqual([
      { question: 'Which tone should the notes use?', answer: 'Plain' },
    ]);
    const html = card(SINGLE, { item, events });
    expect(html).toContain('Huddle answered');
    expect(html).toContain('Plain');
    expect(html).toContain('The terminal shows it as if you had typed it.');
    expect(buttons(html).some((b) => b.includes('Answer in terminal'))).toBe(false);
  });
});

describe('an off button says why in words, not only in its tooltip (owner review 2026-11-17)', () => {
  it('Send before a pick: the reason is a line under the buttons', () => {
    expect(card(SINGLE)).toContain('<p class="card-reason">Pick an answer or type one first.</p>');
    expect(card(MULTI)).toMatch(
      /<p class="card-reason">(Pick an answer or type one first|Answer every question first)\.<\/p>/,
    );
  });
});
