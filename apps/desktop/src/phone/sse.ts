/**
 * A server-sent events parser for the phone page (M6, F26). The page reads `/api/stream` with `fetch` because
 * `EventSource` cannot send the `Authorization` header, and the device token must never go into a URL. So the stream
 * is parsed here, following the WHATWG "event stream interpretation" rules the core's PhoneServer writes to:
 * lines end in LF, CRLF or CR; a line starting with `:` is a comment (the heartbeat); `event`, `data`, `id` and
 * `retry` fields; a blank line dispatches. Pure: text in, events out.
 */

export interface SseEvent {
  /** `message` when the server named none. */
  event: string;
  data: string;
}

export interface SseParser {
  /** Feed the next decoded chunk; returns the events it completed. */
  push(chunk: string): SseEvent[];
  /** The last `retry:` value the server sent (ms), or null. */
  retryMs(): number | null;
}

/** The longest buffered partial line or event kept (a stream that never ends a line is cut off, not grown). */
export const SSE_MAX_BUFFER = 1024 * 1024;

export function createSseParser(): SseParser {
  let buffer = '';
  let eventName = '';
  let data: string[] = [];
  let hasData = false;
  let retry: number | null = null;
  let pendingSize = 0;
  // A CR at the very end of a chunk may be the first half of a CRLF split across chunks.
  let skipLeadingLf = false;

  const reset = () => {
    eventName = '';
    data = [];
    hasData = false;
    pendingSize = 0;
  };

  const line = (text: string, out: SseEvent[]) => {
    if (text === '') {
      if (hasData) out.push({ event: eventName === '' ? 'message' : eventName, data: data.join('\n') });
      reset();
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        eventName = value;
        break;
      case 'data':
        pendingSize += value.length;
        if (pendingSize > SSE_MAX_BUFFER) {
          reset();
          return;
        }
        data.push(value);
        hasData = true;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) retry = Number(value);
        break;
      default:
        // `id` and unknown fields: nothing the page needs.
        break;
    }
  };

  return {
    push(chunk: string): SseEvent[] {
      const out: SseEvent[] = [];
      let text = chunk;
      if (skipLeadingLf && text.startsWith('\n')) text = text.slice(1);
      skipLeadingLf = false;
      buffer += text;
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        line(buffer.slice(start, i), out);
        if (ch === '\r') {
          if (i + 1 < buffer.length) {
            if (buffer[i + 1] === '\n') i += 1;
          } else {
            skipLeadingLf = true;
          }
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      if (buffer.length > SSE_MAX_BUFFER) buffer = '';
      return out;
    },
    retryMs: () => retry,
  };
}
