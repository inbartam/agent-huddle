/**
 * Test helper: every event a HuddleCore stored in `<dataDir>/huddle.sqlite` (M5), session by session, read through
 * its own connection that is closed again before returning (Windows keeps open files locked). Call it after the
 * core's `dispose()`, or at least after its writes have flushed. Not exported from the package.
 */
import path from 'node:path';
import type { HuddleEvent } from '@huddle/shared';
import { SqliteEventStore } from '../store/sqlite-store.js';

export async function readStoredLog(dataDir: string, sessionId?: string): Promise<HuddleEvent[]> {
  const store = new SqliteEventStore({ file: path.join(dataDir, 'huddle.sqlite') });
  try {
    const ids = sessionId !== undefined ? [sessionId] : (await store.listSessions()).map((s) => s.sessionId);
    const out: HuddleEvent[] = [];
    for (const id of ids) for await (const event of store.readSession(id)) out.push(event);
    return out;
  } finally {
    await store.close();
  }
}
