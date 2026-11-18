import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentKey, type HuddleEvent } from '@huddle/shared';
import {
  defaultEventsDir,
  InvalidSessionIdError,
  isValidSessionId,
  JsonlEventStore,
  MAX_AGENT_EVENTS,
} from './jsonl-store.js';

let dir: string;
const stores: JsonlEventStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'huddle-store-'));
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await rm(dir, { recursive: true, force: true });
});

function makeStore(): JsonlEventStore {
  const store = new JsonlEventStore({ baseDir: dir, flushDelayMs: 5 });
  stores.push(store);
  return store;
}

let seq = 0;
function notification(sessionId: string, ts: number, agentId: string | null = null, message = 'hello'): HuddleEvent {
  seq += 1;
  return {
    id: `id-${String(seq).padStart(6, '0')}`,
    type: 'notification.raised',
    ts,
    sessionId,
    agentKey: agentKey(sessionId, agentId),
    source: 'hook',
    notificationType: null,
    message,
  };
}

async function collect(iterable: AsyncIterable<HuddleEvent>): Promise<HuddleEvent[]> {
  const out: HuddleEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('JsonlEventStore', () => {
  it('round-trips events per session and keeps order', async () => {
    const store = makeStore();
    const a1 = notification('sess-a', 1);
    const a2 = notification('sess-a', 2);
    const b1 = notification('sess-b', 3);
    const a = [a1, a2];
    const b = [b1];
    await store.append([a1, b1]);
    await store.append([a2]);
    expect(await collect(store.readSession('sess-a'))).toEqual(a);
    expect(await collect(store.readSession('sess-b'))).toEqual(b);
    expect(await collect(store.readSession('sess-none'))).toEqual([]);

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['index.json', 'sess-a.jsonl', 'sess-b.jsonl']);

    // A new store instance over the same folder sees the same data.
    const reopened = makeStore();
    expect(await collect(reopened.readSession('sess-a'))).toEqual(a);
    expect(await reopened.listSessions()).toEqual([
      { sessionId: 'sess-b', firstTs: 3, lastTs: 3 },
      { sessionId: 'sess-a', firstTs: 1, lastTs: 2 },
    ]);
  });

  it('returns from append without waiting for disk, and batches the write', async () => {
    const store = makeStore();
    const pending = store.append([notification('sess-a', 1)]);
    await expect(readdir(dir)).resolves.toEqual([]);
    await pending;
    expect(await readdir(dir)).toContain('sess-a.jsonl');
  });

  it('tolerates a half-written last line and does not glue the next event to it', async () => {
    const store = makeStore();
    const first = notification('sess-a', 1);
    await store.append([first]);
    // Simulate a crash mid-write: a partial JSON line without a newline.
    await appendFile(path.join(dir, 'sess-a.jsonl'), '{"id":"broken","type":"notif');

    const afterCrash = makeStore();
    expect(await collect(afterCrash.readSession('sess-a'))).toEqual([first]);
    expect(afterCrash.stats().skippedLines).toBe(1);

    const next = notification('sess-a', 2);
    await afterCrash.append([next]);
    expect(await collect(afterCrash.readSession('sess-a'))).toEqual([first, next]);
  });

  it('skips blank, non-JSON and non-event lines anywhere in the file', async () => {
    const good = notification('sess-a', 1);
    await writeFile(path.join(dir, 'sess-a.jsonl'), `\n${JSON.stringify(good)}\nnot json\n{"foo":1}\n\n`);
    const store = makeStore();
    expect(await collect(store.readSession('sess-a'))).toEqual([good]);
  });

  it('readAgentEvents returns the newest events of one agent, oldest first, capped at 500', async () => {
    const store = makeStore();
    const events: HuddleEvent[] = [];
    for (let i = 0; i < 700; i++) events.push(notification('sess-a', i, i % 2 === 0 ? null : 'sub1'));
    await store.append(events);

    const main = events.filter((e) => e.agentKey === 'sess-a');
    const sub = events.filter((e) => e.agentKey === 'sess-a::sub1');
    expect(await store.readAgentEvents('sess-a', 3)).toEqual(main.slice(-3));
    expect(await store.readAgentEvents('sess-a::sub1', 2)).toEqual(sub.slice(-2));
    expect(await store.readAgentEvents('sess-a')).toEqual(main);
    expect(await store.readAgentEvents('sess-a::sub1', 10_000)).toHaveLength(350);

    const many: HuddleEvent[] = [];
    for (let i = 0; i < 600; i++) many.push(notification('sess-b', i));
    await store.append(many);
    const capped = await store.readAgentEvents('sess-b', 10_000);
    expect(capped).toHaveLength(MAX_AGENT_EVENTS);
    expect(capped).toEqual(many.slice(-MAX_AGENT_EVENTS));
    expect(await store.readAgentEvents('sess-b', 0)).toHaveLength(1);
    expect(await store.readAgentEvents('sess-b', Number.NaN)).toHaveLength(MAX_AGENT_EVENTS);
    expect(await store.readAgentEvents('sess-unknown::x', 5)).toEqual([]);
  });

  it('rejects session ids that are not safe file names', async () => {
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a..b', 'CON', 'nul.txt', 'x'.repeat(200), 'a:b']) {
      expect(isValidSessionId(bad), bad).toBe(false);
    }
    expect(isValidSessionId('3f2c9a10-1b2c-4d5e-8f90-0123456789ab')).toBe(true);

    const store = makeStore();
    await expect(collect(store.readSession('../escape'))).rejects.toBeInstanceOf(InvalidSessionIdError);
    await expect(store.readAgentEvents('../escape::a1')).rejects.toBeInstanceOf(InvalidSessionIdError);

    await store.append([notification('../escape', 1), notification('ok-session', 2)]);
    expect(store.stats().rejectedInvalidSession).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['index.json', 'ok-session.jsonl']);
    expect(await readdir(path.dirname(dir))).not.toContain('escape.jsonl');
  });

  it('keeps every line whole under many concurrent appends', async () => {
    const store = makeStore();
    const big = 'y'.repeat(5000);
    const appends: Promise<void>[] = [];
    const expected: HuddleEvent[] = [];
    for (let i = 0; i < 200; i++) {
      const batch = [notification('sess-a', i, null, big), notification('sess-a', i, 'sub', big)];
      expected.push(...batch);
      appends.push(store.append(batch));
    }
    await Promise.all(appends);
    const text = await readFile(path.join(dir, 'sess-a.jsonl'), 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(400);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(await collect(store.readSession('sess-a'))).toEqual(expected);
  });

  it('never writes tool_response, even if one is smuggled into an event', async () => {
    const store = makeStore();
    const event = {
      ...notification('sess-a', 1),
      tool_response: { secret: 'file contents' },
    } as unknown as HuddleEvent;
    await store.append([event]);
    const text = await readFile(path.join(dir, 'sess-a.jsonl'), 'utf8');
    expect(text).not.toContain('tool_response');
    expect(text).not.toContain('file contents');
    expect(store.stats().strippedToolResponses).toBe(1);
  });

  it('rebuilds a missing or corrupt index from the session files', async () => {
    const store = makeStore();
    await store.append([notification('sess-a', 10), notification('sess-a', 20), notification('sess-b', 5)]);
    await writeFile(path.join(dir, 'index.json'), '{ not json');
    const reopened = makeStore();
    expect(await reopened.listSessions({ limit: 1 })).toEqual([{ sessionId: 'sess-a', firstTs: 10, lastTs: 20 }]);
  });

  it('rejects appends after close', async () => {
    const store = makeStore();
    await store.close();
    await expect(store.append([notification('sess-a', 1)])).rejects.toThrow(/closed/);
  });
});

describe('defaultEventsDir', () => {
  it('uses APPDATA when set', () => {
    expect(defaultEventsDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')).toBe(
      path.join('C:\\Users\\u\\AppData\\Roaming', 'agent-huddle', 'events'),
    );
  });

  it('falls back to the roaming folder on Windows and ~/.config elsewhere', () => {
    expect(defaultEventsDir({}, 'win32', 'C:\\Users\\u')).toBe(
      path.join('C:\\Users\\u', 'AppData', 'Roaming', 'agent-huddle', 'events'),
    );
    expect(defaultEventsDir({}, 'linux', '/home/u')).toBe(path.join('/home/u', '.config', 'agent-huddle', 'events'));
  });
});
