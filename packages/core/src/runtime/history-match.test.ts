/**
 * Search match lines (M5 WP4b, F22): plain text and UTF-16 offsets, matched like the FTS5 `unicode61
 * remove_diacritics 2` tokenizer (word prefix, any case, accents ignored), cut around the first match.
 */
import { describe, expect, it } from 'vitest';
import { CLIP_LIMITS } from '@huddle/shared';
import { searchTerms } from '../store/sqlite-store.js';
import { matchFor, matchRanges } from './history-match.js';

const marked = (text: string, ranges: readonly { start: number; end: number }[]): string[] =>
  ranges.map((r) => text.slice(r.start, r.end));

describe('matchRanges', () => {
  it('marks the matched prefix of each word, ignoring case and accents', () => {
    const text = 'Fix the Café parser; cafés and CAFE tests';
    const { ranges, matched } = matchRanges(text, searchTerms('cafe pars'));
    expect(marked(text, ranges)).toEqual(['Café', 'pars', 'café', 'CAFE']);
    expect([...matched].sort()).toEqual([0, 1]);
  });

  it('only matches at the start of a word, and never inside one', () => {
    const { ranges } = matchRanges('reparse parse', ['parse']);
    expect(ranges).toEqual([{ start: 8, end: 13 }]);
  });

  it('keeps surrogate pairs whole and offsets in UTF-16 units', () => {
    const text = '😀 𝒳yz test';
    const { ranges } = matchRanges(text, ['test']);
    expect(marked(text, ranges)).toEqual(['test']);
    expect(ranges[0]?.start).toBe(text.indexOf('test'));
  });

  it('gives sorted, non-overlapping ranges', () => {
    const { ranges } = matchRanges('a ab abc b bc', ['a', 'ab', 'b']);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]?.start).toBeGreaterThanOrEqual(ranges[i - 1]?.end ?? 0);
  });
});

describe('matchFor', () => {
  const fields = { title: 'Fix parser tests', topic: 'run the parser suite', folder: 'C:/code/alpha', prompt: null };

  it('answers a title match with the whole title and offsets into it', () => {
    expect(matchFor(fields, ['fix', 'parser'])).toEqual({
      field: 'title',
      text: 'Fix parser tests',
      cutStart: false,
      cutEnd: false,
      ranges: [
        { start: 0, end: 3 },
        { start: 4, end: 10 },
      ],
    });
  });

  it('answers a folder match with the whole folder and offsets into it', () => {
    expect(matchFor(fields, ['alpha'])).toEqual({
      field: 'folder',
      text: 'C:/code/alpha',
      cutStart: false,
      cutEnd: false,
      ranges: [{ start: 8, end: 13 }],
    });
  });

  it('is null when no field holds a term', () => {
    expect(matchFor(fields, ['nowhere'])).toBeNull();
  });

  it('breaks ties in the order title, topic, folder, prompt', () => {
    // "parser" is in both title and topic: the title wins the tie.
    expect(matchFor(fields, ['parser'])?.field).toBe('title');
    // The topic holds two terms, the title one: the topic wins on count.
    expect(matchFor(fields, ['parser', 'suite'])?.field).toBe('topic');
    const tied = { title: null, topic: null, folder: 'C:/work/beta', prompt: 'beta prompt' };
    expect(matchFor(tied, ['beta'])?.field).toBe('folder');
  });

  it('never cuts a title or folder, even past the snippet length', () => {
    const folder = `C:/${'deep/'.repeat(100)}needle`;
    const match = matchFor({ title: null, topic: null, folder, prompt: null }, ['needle']);
    expect(match).toMatchObject({ field: 'folder', text: folder, cutStart: false, cutEnd: false });
    expect(folder.length).toBeGreaterThan(CLIP_LIMITS.summary);
    if (match === null) throw new Error('no match');
    expect(marked(match.text, match.ranges)).toEqual(['needle']);
  });

  it('keeps hostile title and folder text plain, with offsets only', () => {
    const title = '<img src=x onerror=alert(1)> <mark>evil</mark> &amp; done';
    const folder = 'C:/<script>/evil"dir';
    const t = matchFor({ title, topic: null, folder: null, prompt: null }, ['evil', 'mark']);
    expect(t).toMatchObject({ field: 'title', text: title });
    if (t === null) throw new Error('no match');
    expect(marked(title, t.ranges)).toEqual(['mark', 'evil', 'mark']);
    const f = matchFor({ title: null, topic: null, folder, prompt: null }, ['script', 'evil']);
    expect(f).toMatchObject({ field: 'folder', text: folder });
    if (f === null) throw new Error('no match');
    expect(marked(folder, f.ranges)).toEqual(['script', 'evil']);
  });

  it('answers the topic or prompt with plain text and offsets', () => {
    expect(matchFor(fields, ['suite'])).toEqual({
      field: 'topic',
      text: 'run the parser suite',
      cutStart: false,
      cutEnd: false,
      ranges: [{ start: 15, end: 20 }],
    });
    expect(matchFor({ ...fields, topic: null, prompt: 'first prompt <b>here</b>' }, ['here'])).toMatchObject({
      field: 'prompt',
      text: 'first prompt <b>here</b>',
      ranges: [{ start: 16, end: 20 }],
    });
  });

  it('cuts a long field around the first match and moves the ranges into the snippet', () => {
    const long = `${'word '.repeat(200)}needle ${'tail '.repeat(100)}`;
    const match = matchFor({ ...fields, topic: long }, ['needle']);
    if (match === null) throw new Error('no match');
    expect(match.text.length).toBeLessThanOrEqual(CLIP_LIMITS.summary);
    expect(match.cutStart).toBe(true);
    expect(match.cutEnd).toBe(true);
    expect(marked(match.text, match.ranges)).toEqual(['needle']);
  });
});
