/**
 * A small Markdown reader for agent replies (a timeline "Turn ended" row opened in the reader). Pure: it turns text
 * into plain data, and MessageText.tsx draws that data with React elements, so every character stays text (no
 * innerHTML, SECURITY.md). It knows only what Claude's replies use most: headings, paragraphs, bullet and numbered
 * lists, fenced code, pipe tables, block quotes and rules; inline `code` and **bold**. Anything else shows as written.
 * Links are not made clickable: the reader never opens anything.
 */

export type Inline = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'strong'; text: string };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
// Every pattern here must stay linear: a reply is agent text, and a lazy run between two whitespace runs took seconds
// on one crafted 4,000-character line (A5-01). Closing hashes are trimmed in code (headingText).
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
// Direction overrides and isolates can make agent text read backwards (A5-02). U+200D stays: emoji sequences need it.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
// Every line break that JavaScript's `.` refuses (R-05): CRLF, a lone CR, U+2028 and U+2029. One left inside a line
// made HEADING's `(.*)$` backtrack over a long run of spaces.
const LINE_BREAK = /\r\n?|[\u2028\u2029]/g;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Agent text without direction overrides and isolates (A5-02). Every renderer path that shows or reuses it calls this. */
export function stripBidi(text: string): string {
  return text.replace(BIDI, '');
}

/** A heading's words without the optional closing `#`s (`## Title ##`), done with a loop, not a pattern. */
function headingText(raw: string): string {
  const t = raw.trimEnd();
  let end = t.length;
  while (end > 0 && t[end - 1] === '#') end--;
  if (end === t.length) return t;
  const before = end === 0 ? ' ' : t[end - 1];
  return before === ' ' || before === '\t' ? t.slice(0, end).trimEnd() : t;
}

function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const isTableRow = (line: string) => line.includes('|') && line.trim() !== '';

/** Lines that end a paragraph because they start another block. */
function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    (isTableRow(line) && next !== undefined && TABLE_SEP.test(next))
  );
}

export function parseMarkdown(source: string): Block[] {
  const lines = stripBidi(source).replace(LINE_BREAK, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end (a clipped reply can stop inside one).
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) body.push(lines[i++] ?? '');
      i++;
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? '#').length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, text: headingText(heading[2] ?? '') });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (isTableRow(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        const row = cells(lines[i++] ?? '');
        rows.push(head.map((_, c) => row[c] ?? ''));
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: string[] = [];
      const start = numbered ? Number(numbered[1]) : 1;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const m = ordered ? NUMBERED.exec(l) : BULLET.exec(l);
        if (m) {
          items.push((ordered ? m[2] : m[1]) ?? '');
          i++;
        } else if (l.trim() !== '' && /^\s{2,}\S/.test(l) && items.length > 0) {
          // An indented line continues the item above (nested lists read as continuation text).
          items[items.length - 1] = `${items[items.length - 1] ?? ''}\n${l.trim()}`;
          i++;
        } else break;
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      let m: RegExpExecArray | null;
      while (i < lines.length && (m = QUOTE.exec(lines[i] ?? ''))) {
        body.push(m[1] ?? '');
        i++;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    const body: string[] = [line];
    i++;
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !startsBlock(lines[i] ?? '', lines[i + 1])) {
      body.push(lines[i++] ?? '');
    }
    blocks.push({ kind: 'para', text: body.join('\n') });
  }
  return blocks;
}

/** Inline `code` first (nothing inside it is read), then **bold** in the text between. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const push = (kind: Inline['kind'], t: string) => {
    if (t === '') return;
    const last = out[out.length - 1];
    if (kind === 'text' && last?.kind === 'text') last.text += t;
    else out.push({ kind, text: t });
  };
  const codeParts = text.split(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
  // split with two groups yields: text, ticks, code, text, ticks, code, text…
  for (let p = 0; p < codeParts.length; p += 3) {
    const plain = codeParts[p] ?? '';
    const strongParts = plain.split(/\*\*(?=\S)([\s\S]*?\S)\*\*/);
    strongParts.forEach((s, j) => {
      push(j % 2 === 1 ? 'strong' : 'text', s);
    });
    const code = codeParts[p + 2];
    if (code !== undefined) push('code', code);
  }
  return out;
}

/**
 * One line of a reply for a one-line preview (a timeline row, a hand-off summary): its first non-empty line, without
 * the Markdown marks a reader would not see (heading #, list bullet or number, quote >, **, `). Pure; text stays text.
 */
export function plainLine(text: string | null | undefined): string {
  if (!text) return '';
  const lines = stripBidi(text).replace(LINE_BREAK, '\n').split('\n');
  const line = lines.find((l) => l.trim() !== '' && !FENCE.test(l) && !RULE.test(l) && !TABLE_SEP.test(l)) ?? '';
  const h = HEADING.exec(line);
  const head = h ? headingText(h[2] ?? '') : line;
  const bare = head.replace(BULLET, '$1').replace(NUMBERED, '$2').replace(QUOTE, '$1').trim();
  return parseInline(bare)
    .map((p) => p.text)
    .join('');
}
