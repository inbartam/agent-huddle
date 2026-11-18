/**
 * How every event store turns a HuddleEvent into stored text and back. Shared by `JsonlEventStore` and
 * `SqliteEventStore`, so the masking pass and the `tool_response` strip are one implementation (SECURITY.md).
 */
import type { AgentKey, HuddleEvent } from '@huddle/shared';
import { maskSecrets } from '../privacy/redact.js';

/** Identifier fields the stores key files and lookups on: never rewritten by the masking pass. */
export const UNMASKED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'source',
  'sessionId',
  'agentKey',
  'parentKey',
  'agentId',
  'childAgentId',
  'toolUseId',
  'requestId',
  'promptId',
  'taskId',
  'itemId',
  'inputDigest',
]);

/**
 * JSON with every `tool_response` key dropped, at any depth, and secrets masked in every string that is not an
 * identifier. The normalizers mask already; this is the defensive second pass (SECURITY.md), so text that reaches
 * the log some other way (a rename, a role description, a future event source) is covered too.
 * `onStrippedToolResponse` is called once per dropped key (the stores count it).
 */
export function serializeEvent(event: HuddleEvent, onStrippedToolResponse: () => void): string {
  return JSON.stringify(event, (key, value: unknown) => {
    if (key === 'tool_response') {
      onStrippedToolResponse();
      return undefined;
    }
    if (typeof value === 'string' && !UNMASKED_KEYS.has(key)) return maskSecrets(value);
    return value;
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The envelope every event has. Anything that lacks it is a broken or foreign record and is skipped. */
export function isEventShape(value: unknown): value is HuddleEvent {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.ts === 'number' &&
    typeof value.sessionId === 'string' &&
    typeof value.agentKey === 'string' &&
    typeof value.source === 'string'
  );
}

/** Parses one stored record; null when it is not JSON or not an event. */
export function parseStoredEvent(text: string): HuddleEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isEventShape(value) ? value : null;
}

/** The session part of an agent key (`<sessionId>` or `<sessionId>::<agentId>`, see model.ts). */
export function sessionOfAgentKey(key: AgentKey): string {
  const at = key.indexOf('::');
  return at === -1 ? key : key.slice(0, at);
}
