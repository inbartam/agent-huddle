/**
 * The phone page's SSE parser (M6, F26): the frames PhoneServer writes (`retry`, `event: view`, heartbeats), split
 * anywhere across chunks, every line ending, multi-line data, and a runaway line.
 */
import { describe, expect, it } from 'vitest';
import { createSseParser, SSE_MAX_BUFFER } from './sse.js';

describe('createSseParser', () => {
  it('reads what PhoneServer writes on connect', () => {
    const p = createSseParser();
    const out = p.push('retry: 3000\n\nevent: view\ndata: {"a":1}\n\n: heartbeat\n\n');
    expect(out).toEqual([{ event: 'view', data: '{"a":1}' }]);
    expect(p.retryMs()).toBe(3000);
  });

  it('completes an event split at any point between chunks', () => {
    const frame = 'event: view\ndata: {"sessions":[],"inbox":[]}\n\n';
    for (let cut = 1; cut < frame.length; cut += 1) {
      const p = createSseParser();
      const first = p.push(frame.slice(0, cut));
      const second = p.push(frame.slice(cut));
      expect([...first, ...second]).toEqual([{ event: 'view', data: '{"sessions":[],"inbox":[]}' }]);
    }
  });

  it('accepts CRLF and CR line endings, including a CRLF split across chunks', () => {
    expect(createSseParser().push('event: view\r\ndata: x\r\n\r\n')).toEqual([{ event: 'view', data: 'x' }]);
    expect(createSseParser().push('event: view\rdata: y\r\r')).toEqual([{ event: 'view', data: 'y' }]);
    const p = createSseParser();
    expect(p.push('data: z\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual([{ event: 'message', data: 'z' }]);
  });

  it('joins data lines, keeps a value without a space after the colon, ignores comments and unknown fields', () => {
    const out = createSseParser().push(': hi\nid: 7\nfoo: bar\ndata:one\ndata: two\n\n');
    expect(out).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  it('dispatches nothing for an event without data, and resets the name after each event', () => {
    const p = createSseParser();
    expect(p.push('event: view\n\n')).toEqual([]);
    expect(p.push('data: a\n\n')).toEqual([{ event: 'message', data: 'a' }]);
  });

  it('drops a line that never ends instead of growing without bound', () => {
    const p = createSseParser();
    expect(p.push('data: ' + 'x'.repeat(SSE_MAX_BUFFER + 10))).toEqual([]);
    expect(p.push('\n\nevent: view\ndata: ok\n\n')).toEqual([{ event: 'view', data: 'ok' }]);
  });
});
