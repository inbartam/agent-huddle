import { describe, expect, it } from 'vitest';
import { HEAD_CHARS, LineSplitter } from './line-splitter.js';

const lines = (out: ReturnType<LineSplitter['push']>) =>
  out.map((l) => (l.kind === 'line' ? l.line : `<big:${l.head}>`));

describe('LineSplitter', () => {
  it('joins partial chunks and splits several lines in one chunk', () => {
    const s = new LineSplitter();
    expect(lines(s.push('{"a":'))).toEqual([]);
    expect(lines(s.push('1}\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(lines(s.push(':3}\n'))).toEqual(['{"c":3}']);
  });

  it('strips CRLF, also when the \\r and \\n arrive in different chunks', () => {
    const s = new LineSplitter();
    expect(lines(s.push('one\r'))).toEqual([]);
    expect(lines(s.push('\ntwo\r\n'))).toEqual(['one', 'two']);
  });

  it('skips blank lines', () => {
    expect(lines(new LineSplitter().push('\n\r\n  \nx\n'))).toEqual(['x']);
  });

  it('keeps a UTF-8 character split across two Buffers', () => {
    const s = new LineSplitter();
    const bytes = Buffer.from('{"t":"héllo ✓"}\n', 'utf8');
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte check mark
    expect(lines(s.push(bytes.subarray(0, cut)))).toEqual([]);
    expect(lines(s.push(bytes.subarray(cut)))).toEqual(['{"t":"héllo ✓"}']);
  });

  it('drops a line over the cap, keeping its head, and carries on with the next line', () => {
    const s = new LineSplitter(100);
    const big = `{"type":"result",${'x'.repeat(300)}`;
    const out = [...s.push(big.slice(0, 150)), ...s.push(big.slice(150)), ...s.push('\n{"ok":1}\n')];
    expect(out).toEqual([
      { kind: 'oversized', head: big.slice(0, Math.min(HEAD_CHARS, 150)) },
      { kind: 'line', line: '{"ok":1}' },
    ]);
  });

  it('reports a too-long line that arrived in one chunk', () => {
    const out = new LineSplitter(10).push('0123456789ABC\nok\n');
    expect(out).toEqual([
      { kind: 'oversized', head: '0123456789ABC' },
      { kind: 'line', line: 'ok' },
    ]);
  });

  it('returns a last line without a newline on end()', () => {
    const s = new LineSplitter();
    s.push('a\nlast');
    expect(lines(s.end())).toEqual(['last']);
    expect(lines(s.end())).toEqual([]);
  });
});
