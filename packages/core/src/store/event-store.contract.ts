/**
 * The behavior every `HuddleEventStore` shares, run against each implementation by its own test file
 * (`jsonl-store.contract.test.ts`, `sqlite-store.test.ts`). Not a test file itself: it exports the suite.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import { InvalidSessionIdError, MAX_AGENT_EVENTS, type HuddleEventStore } from './jsonl-store.js';

export interface EventStoreContractOptions {
  /** A store over `dir`. Called again with the same `dir` to check that data survives a reopen. */
  open: (dir: string) => HuddleEventStore;
  /**
   * True when re-appending an id that is stored already is a no-op. The JSONL log keeps both copies (it never
   * reads its file back on append); the copies fold when the log is replayed into SQLite (M5 migration).
   */
  dedupesOnId: boolean;
}

async function collect(iterable: AsyncIterable<HuddleEvent>): Promise<HuddleEvent[]> {
  const out: HuddleEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

export function describeEventStoreContract(name: string, options: EventStoreContractOptions): void {
  describe(`${name}: HuddleEventStore contract`, () => {
    let dir: string;
    const stores: HuddleEventStore[] = [];
    let counter = 0;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'huddle-contract-'));
    });

    afterEach(async () => {
      // Close before removing: Windows refuses to delete files that are still open.
      await Promise.all(stores.splice(0).map((store) => store.close()));
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });

    function open(): HuddleEventStore {
      const store = options.open(dir);
      stores.push(store);
      return store;
    }

    function event(sessionId: string, ts: number, agentId: string | null = null, message = 'hello'): HuddleEvent {
      counter += 1;
      return {
        id: `c-${String(counter).padStart(6, '0')}`,
        type: 'notification.raised',
        ts,
        sessionId,
        agentKey: agentKey(sessionId, agentId),
        source: 'hook',
        notificationType: null,
        message,
      };
    }

    it('reads each session back in append order, across appends and sessions', async () => {
      const store = open();
      const a1 = event('sess-a', 5);
      const a2 = event('sess-a', 1); // older ts, later append: append order wins
      const b1 = event('sess-b', 3);
      const a3 = event('sess-a', 9, 'sub1');
      await store.append([a1, b1]);
      await store.append([a2, a3]);
      expect(await collect(store.readSession('sess-a'))).toEqual([a1, a2, a3]);
      expect(await collect(store.readSession('sess-b'))).toEqual([b1]);
      expect(await collect(store.readSession('sess-none'))).toEqual([]);
    });

    it('keeps order across more events than one read chunk', async () => {
      const store = open();
      const events: HuddleEvent[] = [];
      for (let i = 0; i < 1234; i++) events.push(event('sess-big', i));
      await store.append(events);
      expect(await collect(store.readSession('sess-big'))).toEqual(events);
    });

    it(
      options.dedupesOnId ? 're-appending a stored id is a no-op' : 're-appending a stored id keeps both copies',
      async () => {
        const store = open();
        const a1 = event('sess-a', 1);
        const a2 = event('sess-a', 2);
        await store.append([a1, a2]);
        await store.append([a1]);
        const expected = options.dedupesOnId ? [a1, a2] : [a1, a2, a1];
        expect(await collect(store.readSession('sess-a'))).toEqual(expected);
        expect(await store.listSessions()).toEqual([{ sessionId: 'sess-a', firstTs: 1, lastTs: 2 }]);
      },
    );

    it('lists sessions most recently active first, with their time span, and honors the limit', async () => {
      const store = open();
      await store.append([event('sess-a', 10), event('sess-b', 5), event('sess-c', 7)]);
      await store.append([event('sess-a', 20), event('sess-b', 30), event('sess-a', 2)]);
      const all = [
        { sessionId: 'sess-b', firstTs: 5, lastTs: 30 },
        { sessionId: 'sess-a', firstTs: 2, lastTs: 20 },
        { sessionId: 'sess-c', firstTs: 7, lastTs: 7 },
      ];
      expect(await store.listSessions()).toEqual(all);
      expect(await store.listSessions({ limit: 2 })).toEqual(all.slice(0, 2));
      expect(await store.listSessions({ limit: 0 })).toEqual([]);
      expect(await store.listSessions({ limit: 1.9 })).toEqual(all.slice(0, 1));
      expect(await store.listSessions({ limit: Number.POSITIVE_INFINITY })).toEqual(all);
    });

    it('breaks a tie in last activity by session id', async () => {
      const store = open();
      await store.append([event('sess-b', 4), event('sess-a', 4), event('sess-c', 1)]);
      expect((await store.listSessions()).map((s) => s.sessionId)).toEqual(['sess-a', 'sess-b', 'sess-c']);
    });

    it('readAgentEvents returns the newest events of one agent, oldest first, capped at 500', async () => {
      const store = open();
      const events: HuddleEvent[] = [];
      for (let i = 0; i < 700; i++) events.push(event('sess-a', i, i % 2 === 0 ? null : 'sub1'));
      await store.append(events);
      const main = events.filter((e) => e.agentKey === 'sess-a');
      const sub = events.filter((e) => e.agentKey === 'sess-a::sub1');
      expect(await store.readAgentEvents('sess-a', 3)).toEqual(main.slice(-3));
      expect(await store.readAgentEvents('sess-a::sub1', 2)).toEqual(sub.slice(-2));
      expect(await store.readAgentEvents('sess-a')).toEqual(main);
      expect(await store.readAgentEvents('sess-a::sub1', 10_000)).toHaveLength(350);

      const many: HuddleEvent[] = [];
      for (let i = 0; i < 600; i++) many.push(event('sess-b', i));
      await store.append(many);
      expect(await store.readAgentEvents('sess-b', 10_000)).toEqual(many.slice(-MAX_AGENT_EVENTS));
      expect(await store.readAgentEvents('sess-b', 0)).toEqual(many.slice(-1));
      expect(await store.readAgentEvents('sess-b', Number.NaN)).toHaveLength(MAX_AGENT_EVENTS);
      expect(await store.readAgentEvents('sess-unknown::x', 5)).toEqual([]);
    });

    it('rejects invalid session ids on every method that takes one, and skips them on append', async () => {
      const store = open();
      for (const bad of ['', '..', '../escape', 'a/b', 'a\\b', '.hidden', 'CON', 'x'.repeat(200), 'a:b']) {
        await expect(collect(store.readSession(bad)), bad).rejects.toBeInstanceOf(InvalidSessionIdError);
        await expect(store.readAgentEvents(`${bad}::a1`), bad).rejects.toBeInstanceOf(InvalidSessionIdError);
      }
      const ok = event('ok-session', 2);
      await store.append([event('../escape', 1), ok]);
      expect(await collect(store.readSession('ok-session'))).toEqual([ok]);
      expect((await store.listSessions()).map((s) => s.sessionId)).toEqual(['ok-session']);
    });

    it('flush makes queued appends visible to a second store on the same data', async () => {
      const store = open();
      const a1 = event('sess-a', 1);
      const pending = store.append([a1]);
      await store.flush();
      await pending;
      const other = open();
      expect(await collect(other.readSession('sess-a'))).toEqual([a1]);
    });

    it('close writes what is queued, rejects later appends, and the data survives a reopen', async () => {
      const store = open();
      const a1 = event('sess-a', 1);
      const queued = store.append([a1]);
      await store.close();
      await queued;
      await expect(store.append([event('sess-a', 2)])).rejects.toThrow(/closed/);
      await store.close(); // twice is fine
      const reopened = open();
      expect(await collect(reopened.readSession('sess-a'))).toEqual([a1]);
      expect(await reopened.listSessions()).toEqual([{ sessionId: 'sess-a', firstTs: 1, lastTs: 1 }]);
    });

    it('never writes tool_response, even if one is smuggled into an event', async () => {
      const store = open();
      const plainEvent = event('sess-a', 1);
      await store.append([{ ...plainEvent, tool_response: { secret: 'file contents' } } as unknown as HuddleEvent]);
      expect(await collect(store.readSession('sess-a'))).toEqual([plainEvent]);
    });
  });
}
