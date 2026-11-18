import { describe, expect, it } from 'vitest';
import { ASK_HISTORY_ANSWER_MAX, ASK_QUESTION_MAX } from '@huddle/shared';
import { parseM5Command, parseM5Query } from './m5-schemas.js';

describe('Ask history (huddle.ask, ask.preview)', () => {
  it('is optional; a first question parses as before', () => {
    expect(parseM5Command({ type: 'huddle.ask', question: ' why? ' })).toEqual({
      type: 'huddle.ask',
      question: 'why?',
    });
  });

  it('keeps the newest three turns, drops unknown turn fields, leaves the clip to the context (masked first)', () => {
    const history = [1, 2, 3, 4, 5].map((n) => ({ question: `q${String(n)}`, answer: `a${String(n)}`, extra: 'x' }));
    history[4] = {
      question: 'q'.repeat(ASK_QUESTION_MAX + 5),
      answer: 'a'.repeat(ASK_HISTORY_ANSWER_MAX + 5),
      extra: 'x',
    };
    const cmd = parseM5Command({ type: 'huddle.ask', question: 'next', history });
    if (cmd?.type !== 'huddle.ask') throw new Error('not parsed');
    expect(cmd.history?.map((t) => t.question.slice(0, 2))).toEqual(['q3', 'q4', 'qq']);
    // Not clipped here: ask-context masks again with the ingest token and only then clips (security review, L2).
    expect(cmd.history?.[2]?.question.length).toBe(ASK_QUESTION_MAX + 5);
    expect(cmd.history?.[2]?.answer.length).toBe(ASK_HISTORY_ANSWER_MAX + 5);
    expect(cmd.history?.[0]).toEqual({ question: 'q3', answer: 'a3' });
    const q = parseM5Query({ type: 'ask.preview', question: 'next', history });
    if (q?.type !== 'ask.preview') throw new Error('not parsed');
    expect(q.history).toHaveLength(3);
  });

  it('masks secrets, also one that sits at the cap', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwx';
    const answer = `${'a'.repeat(ASK_HISTORY_ANSWER_MAX - 20)} ${secret}`;
    const question = `${'q'.repeat(ASK_QUESTION_MAX - 15)} ${secret}`;
    const cmd = parseM5Command({ type: 'huddle.ask', question: 'q', history: [{ question, answer }] });
    if (cmd?.type !== 'huddle.ask') throw new Error('not parsed');
    const turn = cmd.history?.[0];
    expect(turn?.answer).not.toContain('abcdefgh');
    expect(turn?.answer).toContain('sk-<re');
    expect(turn?.question).not.toContain('api03-ab');
  });

  it('refuses a wrong shape, too many turns or absurdly long text (null, never a throw)', () => {
    const ask = (history: unknown) => parseM5Command({ type: 'huddle.ask', question: 'q', history });
    expect(ask('not a list')).toBeNull();
    expect(ask([{ question: 'q' }])).toBeNull();
    expect(ask([{ question: 1, answer: 'a' }])).toBeNull();
    expect(ask(Array.from({ length: 21 }, () => ({ question: 'q', answer: 'a' })))).toBeNull();
    expect(ask([{ question: 'q', answer: 'a'.repeat(ASK_HISTORY_ANSWER_MAX * 4 + 1) }])).toBeNull();
  });
});
