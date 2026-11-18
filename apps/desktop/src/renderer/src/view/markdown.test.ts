/** One-line previews of Markdown replies (2026-11-18): the marks a reader would not see are dropped, text stays text. */
import { describe, expect, it } from 'vitest';
import { parseMarkdown, plainLine } from './markdown.js';

describe('plainLine', () => {
  it('drops heading, bullet, number and quote marks, bold and code ticks', () => {
    expect(plainLine('## Summary of the run')).toBe('Summary of the run');
    expect(plainLine('- **Agent Huddle, milestone 5**: three subagents')).toBe(
      'Agent Huddle, milestone 5: three subagents',
    );
    expect(plainLine('2. Ran `npm test`')).toBe('Ran npm test');
    expect(plainLine('> quoted')).toBe('quoted');
  });

  it('takes the first line with words, skipping blank lines, fences and rules', () => {
    expect(plainLine('\n\n```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(plainLine('---\nDone.')).toBe('Done.');
    expect(plainLine(null)).toBe('');
  });

  it('keeps markup it does not know, and HTML, as typed characters', () => {
    expect(plainLine('<img src=x onerror=alert(1)> [x](javascript:alert(1))')).toBe(
      '<img src=x onerror=alert(1)> [x](javascript:alert(1))',
    );
  });
});

describe('hostile input (A5-01)', () => {
  const hostile = [
    '# a' + ' '.repeat(3900) + 'b',
    '#' + ' '.repeat(4000) + 'b',
    '|--' + ' '.repeat(4000) + 'x',
    '`a ' + ' '.repeat(4000),
    '- ' + ' '.repeat(4000) + 'x',
    ' '.repeat(4000) + 'x',
    '```' + ' '.repeat(4000) + 'x',
    '> ' + ' '.repeat(4000) + 'x',
    '1. ' + ' '.repeat(4000) + 'x',
    '**a' + ' '.repeat(4000),
  ];

  it.each(hostile.map((l, i) => [i, l] as const))('line %i stays fast in parseMarkdown and plainLine', (i, line) => {
    const t0 = performance.now();
    parseMarkdown(line);
    plainLine(line);
    // The heading line must be under 50 ms; the bounded-quadratic ones (A5-06, 4-7 ms alone) get headroom for a loaded machine.
    expect(performance.now() - t0).toBeLessThan(i === 0 ? 50 : 200);
  });

  it.each(['\r', ' ', ' '])('a heading run that ends in %j stays fast (R-05)', (end) => {
    const line = '#' + ' '.repeat(20000) + end;
    const t0 = performance.now();
    parseMarkdown(line);
    plainLine(line);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('treats a lone \\r, U+2028 and U+2029 as line breaks', () => {
    expect(plainLine(' first second')).toBe('first');
    expect(plainLine('\rfirst\rsecond')).toBe('first');
    expect(parseMarkdown('# A b')).toEqual([
      { kind: 'heading', level: 1, text: 'A' },
      { kind: 'para', text: 'b' },
    ]);
  });

  it('still trims closing hashes in headings', () => {
    expect(plainLine('## Title ##')).toBe('Title');
    expect(plainLine('## C#')).toBe('C#');
    expect(parseMarkdown('## Title ##')).toEqual([{ kind: 'heading', level: 2, text: 'Title' }]);
    expect(parseMarkdown('## C#')).toEqual([{ kind: 'heading', level: 2, text: 'C#' }]);
  });
});

describe('bidi controls (A5-02)', () => {
  it('strips direction overrides and isolates, but keeps the zero-width joiner', () => {
    expect(parseMarkdown('evil‮txt.exe')).toEqual([{ kind: 'para', text: 'eviltxt.exe' }]);
    expect(plainLine('a⁦b⁩c‪d‬')).toBe('abcd');
    expect(plainLine('\u{1F468}‍\u{1F469}')).toBe('\u{1F468}‍\u{1F469}');
  });
});
