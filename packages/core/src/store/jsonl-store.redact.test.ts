/** Security review M1, finding 2: the store masks secrets again on write (defensive pass). */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HuddleEvent } from '@huddle/shared';
import { JsonlEventStore } from './jsonl-store.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('JsonlEventStore masking pass', () => {
  it('masks secrets in free text that reached it unmasked, and leaves identifiers alone', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-store-redact-'));
    roots.push(root);
    const store = new JsonlEventStore({ baseDir: root });
    const event: HuddleEvent = {
      id: 'evt-token=1',
      type: 'control.applied',
      ts: 1,
      sessionId: 'sess-1',
      agentKey: 'sess-1',
      source: 'user',
      action: 'rename',
      detail: 'my API_KEY=abc123 and sk-ant-api03-AbCdEfGhIjKlMnOpQrSt',
    };
    await store.append([event]);
    await store.close();
    const text = await fsp.readFile(path.join(root, 'sess-1.jsonl'), 'utf8');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('AbCdEfGhIjKlMnOpQrSt');
    expect(text).toContain('API_KEY=<redacted>');
    // `id` is an identifier: never rewritten, even when it looks like an assignment.
    expect(text).toContain('"id":"evt-token=1"');
  });
});
