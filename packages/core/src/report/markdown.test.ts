/**
 * Report Markdown (F23): agent text renders inert in a CommonMark / GFM viewer; estimates and unknowns are labeled.
 */
import { describe, expect, it } from 'vitest';
import { builder, HOSTILE, S, sampleSession } from '../test/report-events.js';
import { escapeMarkdown, formatDuration, formatInt, renderReportMarkdown } from './markdown.js';
import { buildRunReport } from './run-report.js';

/** What is left once every backslash escape is taken out: nothing Markdown could act on may remain. */
function unescaped(text: string): string {
  return text.replace(/\\[\s\S]/g, '');
}

const HOSTILE_INPUTS = [
  '[x](javascript:alert(1))',
  '![i](http://x)',
  '<img src=x onerror=alert(1)>',
  '```\nfence\n```',
  '~~~\nfence\n~~~',
  '# heading',
  '| a | b |',
  '- item',
  '1. item',
  '> quote',
  '*em* _em_ **strong**',
  '`code`',
  '&lt;script&gt;',
  '[ref]: http://x',
  'see https://evil.example and www.evil.example',
  'line one\nline two\r\n# second line heading',
  'a\\[b\\]',
];

describe('escapeMarkdown', () => {
  it.each(HOSTILE_INPUTS)('leaves nothing active in %j', (input) => {
    const out = escapeMarkdown(input);
    expect(out).not.toMatch(/[\r\n]/);
    expect(unescaped(out)).not.toMatch(/[[\]()<>!`*_#|~&\\]/);
    expect(out).not.toMatch(/(^|[^\\])\]\(/);
    expect(out).not.toMatch(/(^|[^\\])<[a-z/]/i);
  });

  it('breaks bare URL autolinks', () => {
    expect(escapeMarkdown('https://x.example')).toBe('https\\://x.example');
    expect(escapeMarkdown('www.x.example')).toBe('www\\.x.example');
  });

  it('escapes a leading list or heading marker', () => {
    expect(escapeMarkdown('- a')).toBe('\\- a');
    expect(escapeMarkdown('= a')).toBe('\\= a');
    expect(escapeMarkdown('12. a')).toBe('12\\. a');
    expect(escapeMarkdown('+ a')).toBe('\\+ a');
  });

  it('drops format characters: bidi overrides and isolates, zero-width characters, the BOM (L6)', () => {
    // "evil\u202Etxt.exe" shows as "evilexe.txt" in a bidi-aware viewer.
    expect(escapeMarkdown('evil\u202Etxt.exe')).toBe('eviltxt.exe');
    expect(escapeMarkdown('a\u202Ab\u202Bc\u202Cd\u202De\u2066f\u2067g\u2068h\u2069i')).toBe('abcdefghi');
    expect(escapeMarkdown('to\u200Bk\u200Ce\u200Dn\u2060\uFEFF')).toBe('token');
    // A zero-width space cannot hide an autolink from the URL escape.
    expect(escapeMarkdown('https\u200B://x.example')).toBe('https\\://x.example');
    expect(escapeMarkdown('x\u00ADy')).toBe('xy');
  });

  it('keeps ordinary text readable', () => {
    expect(escapeMarkdown('C:/Users/user/project/src/main.ts')).toBe('C:/Users/user/project/src/main.ts');
    expect(escapeMarkdown('npm test')).toBe('npm test');
  });
});

describe('formatting', () => {
  it('formats integers without a locale', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(1234567)).toBe('1,234,567');
    expect(formatInt(-1000)).toBe('-1,000');
  });

  it('formats durations, unknown included', () => {
    expect(formatDuration(null)).toBe('unknown');
    expect(formatDuration(400)).toBe('0.4 s');
    expect(formatDuration(12_000)).toBe('12 s');
    expect(formatDuration(192_000)).toBe('3 m 12 s');
    expect(formatDuration(3_900_000)).toBe('1 h 05 m');
  });
});

describe('renderReportMarkdown', () => {
  const report = buildRunReport(sampleSession(), S);
  if (report === null) throw new Error('sample session has no report');
  const md = renderReportMarkdown(report);

  it('renders hostile agent text inert', () => {
    // Unescaped forms only: `\<img` is the literal text "<img" in a viewer, `<img` would be HTML.
    expect(md).not.toMatch(/(^|[^\\])\]\(/m);
    expect(md).not.toMatch(/(^|[^\\])!\\?\[/m);
    expect(md).not.toMatch(/(^|[^\\])<(img|script|b)\b/im);
    expect(md).not.toMatch(/(^|[^\\])`/m);
    expect(md).not.toContain('https://evil');
    expect(md).not.toMatch(/(^|[^\\])www\./m);
    // Only the report's own headings start a line with '#'.
    const headings = md.split('\n').filter((l) => l.startsWith('#'));
    expect(headings.every((l) => /^(# Run report: |## |### )/.test(l))).toBe(true);
    // Each hostile value appears only in its escaped form. The prompt is kept as its first line only (the topic).
    const { prompt, ...shown } = HOSTILE;
    for (const value of Object.values(shown)) expect(md).toContain(escapeMarkdown(value));
    expect(md).toContain(`- **Topic:** ${escapeMarkdown(prompt.split('\n')[0] ?? '')}`);
  });

  it('labels estimates and unknowns', () => {
    expect(md).toContain('estimate by Claude Code, not money spent');
    const bare = buildRunReport(
      [
        builder()('session.started', 's', {
          origin: 'attached',
          cwd: null,
          title: null,
          model: null,
          startKind: 'startup',
        }),
      ],
      's',
    );
    if (bare === null) throw new Error('no report');
    const text = renderReportMarkdown(bare);
    expect(text).toContain('- **Model:** unknown');
    expect(text).toContain('- **Ended:** unknown');
    expect(text).toContain('- **Duration:** unknown');
    expect(text).toContain('- **Tokens:** unknown');
    expect(text).toContain('- **Cost:** unknown');
    expect(text).not.toMatch(/\$0\.0000/);
  });

  it('is deterministic', () => {
    expect(renderReportMarkdown(report)).toBe(md);
  });

  it('matches the snapshot', () => {
    expect(md).toMatchSnapshot();
  });
});
