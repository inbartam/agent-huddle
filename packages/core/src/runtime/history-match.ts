/**
 * Why a history search hit matched (M5 WP4b, F22): a plain-text snippet of one stored field and the UTF-16 ranges of
 * the matched words in it. Pure. The renderer builds `<mark>` from the ranges; no markup is ever made here.
 *
 * The words are the ones the FTS5 query used (`searchTerms`), matched the way the index's `unicode61
 * remove_diacritics 2` tokenizer matches them: a word of letters and digits that starts with the term, ignoring case
 * and accents. The range covers the matched prefix of the word in the original text.
 *
 * Which field: the one holding the most distinct terms, ties going to title, topic, folder, prompt in that order. The
 * title and the folder come back whole, exactly as the row holds them (already clipped by the row: CLIP_LIMITS.summary
 * and CLIP_LIMITS.path), never cut, so the renderer can mark the words in the cell itself. The topic and prompt are cut
 * to a snippet around the first match. Null when no field holds a term at all (the tokenizer and this check disagree
 * on some script; the row still matched).
 */
import { CLIP_LIMITS, type HistoryMatch, type HistoryMatchField, type TextRange } from '@huddle/shared';

const WORD = /[\p{L}\p{N}]+/gu;
/** Characters of context kept before the first match when a field is longer than the snippet. */
const CONTEXT_BEFORE = 60;

/** Case and accent folded, as the tokenizer compares. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** How many UTF-16 units of `word` cover a folded prefix of `foldedLength`; null when `word` does not start so. */
function prefixLength(word: string, foldedTerm: string): number | null {
  if (!fold(word).startsWith(foldedTerm)) return null;
  let folded = '';
  let units = 0;
  for (const ch of word) {
    folded += fold(ch);
    units += ch.length;
    if (folded.length >= foldedTerm.length) return units;
  }
  return units;
}

/** Ranges of every word in `text` that starts with one of `terms`, and which terms matched. */
export function matchRanges(text: string, terms: readonly string[]): { ranges: TextRange[]; matched: Set<number> } {
  const folded = terms.map(fold).filter((t) => t.length > 0);
  const ranges: TextRange[] = [];
  const matched = new Set<number>();
  for (const m of text.matchAll(WORD)) {
    const start = m.index;
    let best = 0;
    folded.forEach((term, t) => {
      const len = prefixLength(m[0], term);
      if (len === null) return;
      matched.add(t);
      best = Math.max(best, len);
    });
    if (best > 0) ranges.push({ start, end: start + best });
  }
  return { ranges, matched };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The snippet of `text` around the first range, at most CLIP_LIMITS.summary units, ranges moved into it. */
function snippet(field: HistoryMatchField, text: string, ranges: readonly TextRange[]): HistoryMatch {
  const max = CLIP_LIMITS.summary;
  if (text.length <= max) return { field, text, cutStart: false, cutEnd: false, ranges: [...ranges] };
  const first = ranges[0]?.start ?? 0;
  let from = Math.max(0, Math.min(first - CONTEXT_BEFORE, text.length - max));
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from -= 1;
  let to = Math.min(text.length, from + max);
  if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to -= 1;
  const moved = ranges
    .filter((r) => r.end > from && r.start < to)
    .map((r) => ({ start: Math.max(r.start, from) - from, end: Math.min(r.end, to) - from }));
  return { field, text: text.slice(from, to), cutStart: from > 0, cutEnd: to < text.length, ranges: moved };
}

export interface MatchFields {
  title: string | null;
  topic: string | null;
  folder: string | null;
  prompt: string | null;
}

const ORDER: readonly HistoryMatchField[] = ['title', 'topic', 'folder', 'prompt'];

/** Fields the row shows in full: their match is the whole text, offsets into it, never a snippet. */
const WHOLE: ReadonlySet<HistoryMatchField> = new Set<HistoryMatchField>(['title', 'folder']);

/** Why a hit matched, or null (see the file comment). */
export function matchFor(fields: MatchFields, terms: readonly string[]): HistoryMatch | null {
  let best: { field: HistoryMatchField; text: string; ranges: TextRange[]; score: number } | null = null;
  for (const field of ORDER) {
    const text = fields[field];
    if (text === null || text === '') continue;
    const { ranges, matched } = matchRanges(text, terms);
    if (matched.size > (best?.score ?? 0)) best = { field, text, ranges, score: matched.size };
  }
  if (best === null) return null;
  if (WHOLE.has(best.field)) {
    return { field: best.field, text: best.text, cutStart: false, cutEnd: false, ranges: best.ranges };
  }
  return snippet(best.field, best.text, best.ranges);
}
