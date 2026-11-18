/**
 * Splits a child process's stdout into lines (M4 StreamDriver).
 *
 * - Chunks may end anywhere, including inside a UTF-8 character: a StringDecoder keeps partial characters.
 * - `\n` ends a line; a trailing `\r` is removed (CRLF). Blank lines are skipped.
 * - A line longer than `maxChars` is not kept: its first HEAD_CHARS characters are reported as `oversized` so the
 *   caller can still tell what kind of line it was, and the rest is skipped until the next `\n`. Memory stays bounded.
 */
import { StringDecoder } from 'node:string_decoder';
import { MAX_STREAM_LINE_CHARS } from './stream-schema.js';

/** Characters kept from the start of an oversized line. */
export const HEAD_CHARS = 256;

export type SplitLine = { kind: 'line'; line: string } | { kind: 'oversized'; head: string };

export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  /** Inside an oversized line: skip until the next newline. */
  private skipping = false;
  private head = '';

  constructor(private readonly maxChars: number = MAX_STREAM_LINE_CHARS) {}

  /** Feeds one chunk; returns the lines it completed. */
  push(chunk: Buffer | string): SplitLine[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const out: SplitLine[] = [];
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) break;
      const segment = text.slice(start, nl);
      start = nl + 1;
      if (this.skipping) {
        this.skipping = false;
        out.push({ kind: 'oversized', head: this.head });
        this.head = '';
        continue;
      }
      this.emit(this.buffer + segment, out);
      this.buffer = '';
    }
    const rest = text.slice(start);
    if (!this.skipping && rest.length > 0) {
      this.buffer += rest;
      if (this.buffer.length > this.maxChars) {
        this.skipping = true;
        this.head = this.buffer.slice(0, HEAD_CHARS);
        this.buffer = '';
      }
    }
    return out;
  }

  /** The input ended: returns a last line that had no newline. */
  end(): SplitLine[] {
    const out: SplitLine[] = [];
    const rest = this.buffer + this.decoder.end();
    this.buffer = '';
    if (this.skipping) {
      this.skipping = false;
      out.push({ kind: 'oversized', head: this.head });
      this.head = '';
    } else {
      this.emit(rest, out);
    }
    return out;
  }

  private emit(raw: string, out: SplitLine[]): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > this.maxChars) out.push({ kind: 'oversized', head: line.slice(0, HEAD_CHARS) });
    else if (line.trim().length > 0) out.push({ kind: 'line', line });
  }
}
