/** Text helpers shared across the core (normalizers, detectors, report, store). Pure. */
import { CLIP_LIMITS } from '@huddle/shared';

/** Cuts text to at most `limit` characters, ending with an ellipsis when cut. Never splits a surrogate pair. */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** One line of plain text for an attention title or detail. */
export function plain(text: string, limit: number = CLIP_LIMITS.summary): string {
  return clip(text.replace(/\s+/g, ' ').trim(), limit);
}
