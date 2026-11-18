/**
 * M5 (WP4a): the history, report and Ask commands and the `huddle:query` questions as main checks them. Bad input is
 * refused (null, never a throw); page sizes and indexes are clamped; a run id follows the stores' `isValidSessionId`.
 */
import { describe, expect, it } from 'vitest';
import { parseCommand, parseQuery } from './validate.js';

const rule = { id: 'r', name: 'n', enabled: true, action: 'allow', match: {} };

describe('M5 commands', () => {
  it('accepts the history, report and Ask commands', () => {
    expect(parseCommand({ type: 'history.setRetention', days: 7 })).toEqual({ type: 'history.setRetention', days: 7 });
    expect(parseCommand({ type: 'history.setRetention', days: 1 })).not.toBeNull();
    expect(parseCommand({ type: 'history.setRetention', days: 365 })).not.toBeNull();
    // L4: a lower value carries the previewed run count.
    expect(parseCommand({ type: 'history.setRetention', days: 7, confirm: 212 })).toEqual({
      type: 'history.setRetention',
      days: 7,
      confirm: 212,
    });
    expect(parseCommand({ type: 'history.setRetention', days: 7, confirm: 0 })).not.toBeNull();
    expect(parseCommand({ type: 'history.deleteAll', confirm: 'delete' })).toEqual({
      type: 'history.deleteAll',
      confirm: 'delete',
    });
    expect(parseCommand({ type: 'report.make', sessionId: 'abc-123' })).not.toBeNull();
    expect(parseCommand({ type: 'report.openFile', sessionId: '0b9e4c1a-7f3d-4e2a-9c1b-5d6e7f8a9b0c' })).not.toBeNull();
    expect(parseCommand({ type: 'report.copyPath', sessionId: 'abc_123.v2' })).not.toBeNull();
    expect(parseCommand({ type: 'ask.setEnabled', enabled: true })).toEqual({ type: 'ask.setEnabled', enabled: true });
    expect(parseCommand({ type: 'ask.cancel' })).toEqual({ type: 'ask.cancel' });
  });

  it.each([
    ['retention 0 days', { type: 'history.setRetention', days: 0 }],
    ['retention 366 days', { type: 'history.setRetention', days: 366 }],
    ['retention 1.5 days', { type: 'history.setRetention', days: 1.5 }],
    ['retention as text', { type: 'history.setRetention', days: '30' }],
    ['retention confirm negative', { type: 'history.setRetention', days: 7, confirm: -1 }],
    ['retention confirm fractional', { type: 'history.setRetention', days: 7, confirm: 1.5 }],
    ['retention confirm as text', { type: 'history.setRetention', days: 7, confirm: '212' }],
    ['retention confirm as the word', { type: 'history.setRetention', days: 7, confirm: 'delete' }],
    ['delete-all without the word', { type: 'history.deleteAll' }],
    ['delete-all with another word', { type: 'history.deleteAll', confirm: 'yes' }],
    ['delete-all with the word in capitals', { type: 'history.deleteAll', confirm: 'DELETE' }],
    ['a report for a path', { type: 'report.openFile', sessionId: '..\\..\\windows\\win.ini' }],
    ['a report with a path and no id', { type: 'report.openFile', path: 'C:\\x.md' }],
    ['a report for ..', { type: 'report.make', sessionId: '..' }],
    ['a report for a device name', { type: 'report.make', sessionId: 'CON' }],
    ['a report for a leading dot', { type: 'report.make', sessionId: '.hidden' }],
    ['a report for an over-long id', { type: 'report.copyPath', sessionId: 'a'.repeat(129) }],
    ['ask.setEnabled without a boolean', { type: 'ask.setEnabled', enabled: 'yes' }],
    ['an empty question', { type: 'huddle.ask', question: '   ' }],
    ['a 501-character question', { type: 'huddle.ask', question: 'q'.repeat(501) }],
    ['a question that is not text', { type: 'huddle.ask', question: ['why'] }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseCommand(input)).not.toThrow();
    expect(parseCommand(input)).toBeNull();
  });

  it('trims the Ask question and takes up to 500 characters', () => {
    expect(parseCommand({ type: 'huddle.ask', question: '  why is ui-engineer slow?\n' })).toEqual({
      type: 'huddle.ask',
      question: 'why is ui-engineer slow?',
    });
    expect(parseCommand({ type: 'huddle.ask', question: 'q'.repeat(500) })).not.toBeNull();
  });
});

describe('parseQuery', () => {
  it('still accepts the M4 questions', () => {
    expect(parseQuery({ type: 'pick.folder' })).toEqual({ type: 'pick.folder' });
    expect(parseQuery({ type: 'policy.preview', rule })).not.toBeNull();
  });

  it('accepts every M5 question', () => {
    const queries: unknown[] = [
      { type: 'history.list', limit: 50 },
      {
        type: 'history.list',
        limit: 200,
        before: { startTs: 1, sessionId: 's-1' },
        outcome: 'no_end',
        folder: 'C:\\code\\x',
      },
      { type: 'history.search', text: 'parser', limit: 20, outcome: 'running' },
      { type: 'history.folders' },
      { type: 'history.open', sessionId: 's-1' },
      { type: 'history.stateAt', sessionId: 's-1', index: 412 },
      { type: 'history.events', sessionId: 's-1', fromIndex: 0, limit: 500 },
      {
        type: 'history.events',
        sessionId: 's-1',
        fromIndex: 9,
        limit: 50,
        backward: true,
        agentKey: 's-1::a1',
        full: true,
      },
      { type: 'history.stats' },
      { type: 'history.retentionPreview', days: 7 },
      { type: 'report.get', sessionId: 's-1' },
      { type: 'scorecards.get' },
      { type: 'ask.preview', question: 'why?' },
    ];
    for (const q of queries) expect(parseQuery(q), JSON.stringify(q)).not.toBeNull();
  });

  it('clamps page sizes and indexes instead of refusing them', () => {
    expect(parseQuery({ type: 'history.list', limit: 10_000 })).toEqual({ type: 'history.list', limit: 200 });
    expect(parseQuery({ type: 'history.list', limit: 0 })).toEqual({ type: 'history.list', limit: 1 });
    expect(parseQuery({ type: 'history.search', text: 'x', limit: -5 })).toEqual({
      type: 'history.search',
      text: 'x',
      limit: 1,
    });
    expect(parseQuery({ type: 'history.events', sessionId: 's', fromIndex: -3, limit: 99_999 })).toEqual({
      type: 'history.events',
      sessionId: 's',
      fromIndex: 0,
      limit: 2000,
    });
    expect(parseQuery({ type: 'history.stateAt', sessionId: 's', index: -1 })).toEqual({
      type: 'history.stateAt',
      sessionId: 's',
      index: 0,
    });
  });

  it('trims search text and cuts it at 200 characters', () => {
    expect(parseQuery({ type: 'history.search', text: '  fix  ', limit: 5 })).toEqual({
      type: 'history.search',
      text: 'fix',
      limit: 5,
    });
    const long = parseQuery({ type: 'history.search', text: 'a'.repeat(5000), limit: 5 });
    expect(long?.type === 'history.search' ? long.text.length : -1).toBe(200);
  });

  it('keeps unknown extra fields', () => {
    expect(parseQuery({ type: 'history.stats', future: 1 })).toEqual({ type: 'history.stats', future: 1 });
  });

  it.each([
    ['nothing', undefined],
    ['an unknown type', { type: 'history.sql', sql: 'DROP TABLE events' }],
    ['a list without a limit', { type: 'history.list' }],
    ['a fractional limit', { type: 'history.list', limit: 2.5 }],
    ['a limit as text', { type: 'history.list', limit: '50' }],
    ['NaN as a limit', { type: 'history.list', limit: Number.NaN }],
    ['Infinity as a limit', { type: 'history.list', limit: Number.POSITIVE_INFINITY }],
    ['an unknown outcome', { type: 'history.list', limit: 5, outcome: 'unknown' }],
    ['an empty folder', { type: 'history.list', limit: 5, folder: '' }],
    ['a cursor with a bad session id', { type: 'history.list', limit: 5, before: { startTs: 1, sessionId: '../x' } }],
    ['a cursor with a negative time', { type: 'history.list', limit: 5, before: { startTs: -1, sessionId: 's' } }],
    ['empty search text', { type: 'history.search', text: '   ', limit: 5 }],
    ['search text that is not text', { type: 'history.search', text: 42, limit: 5 }],
    ['a run with a path for an id', { type: 'history.open', sessionId: 'C:\\Windows' }],
    ['a run id with a slash', { type: 'report.get', sessionId: 'a/b' }],
    ['a run id that is a device name', { type: 'history.open', sessionId: 'nul.txt' }],
    ['a run id with ..', { type: 'history.stateAt', sessionId: 'a..b', index: 0 }],
    ['a fractional index', { type: 'history.stateAt', sessionId: 's', index: 1.5 }],
    [
      'events with an empty agent key',
      { type: 'history.events', sessionId: 's', fromIndex: 0, limit: 5, agentKey: '' },
    ],
    ['a retention preview of 0 days', { type: 'history.retentionPreview', days: 0 }],
    ['an empty Ask preview', { type: 'ask.preview', question: '' }],
    ['an over-long Ask preview', { type: 'ask.preview', question: 'q'.repeat(501) }],
    ['a prototype-polluting object', JSON.parse('{"__proto__": {"type": "history.stats"}}') as unknown],
  ])('rejects %s without throwing', (_label, input) => {
    expect(() => parseQuery(input)).not.toThrow();
    expect(parseQuery(input)).toBeNull();
  });
});
