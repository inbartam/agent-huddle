import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, HuddleCommand, HuddleEvent, HuddleState } from '@huddle/shared';
import type { HuddleBridge } from '../../preload/api.js';
import { CORE_UNREACHABLE, displayName, HuddleStore } from './store.js';
import { fixtureState, KEYS } from './testing/fixture.js';

function fakeBridge(state: HuddleState, result: CommandResult = { ok: true }) {
  let push: ((batch: HuddleEvent[]) => void) | null = null;
  const getState = vi.fn(() => Promise.resolve(state));
  const command = vi.fn((_cmd: HuddleCommand) => Promise.resolve(result));
  const bridge: HuddleBridge = {
    getState,
    getEvents: () => Promise.resolve([]),
    query: () => Promise.resolve({ ok: false, code: 'unsupported', message: 'not in this test' }),
    command,
    onEvents(listener) {
      push = listener;
      return () => {
        push = null;
      };
    },
  };
  return {
    bridge,
    getState,
    command,
    push: (batch: HuddleEvent[]) => {
      push?.(batch);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('HuddleStore', () => {
  it('loads state on start and again after each event batch, without overlapping', async () => {
    const fake = fakeBridge(fixtureState());
    const store = new HuddleStore(fake.bridge);
    const stop = store.start();
    await flush();
    expect(store.getSnapshot().state?.rootKeys).toEqual([KEYS.main]);
    fake.push([]);
    fake.push([]);
    fake.push([]);
    await flush();
    // 1 initial + 1 for the first batch + 1 for the two that landed during that refresh.
    expect(fake.getState.mock.calls.length).toBe(3);
    stop();
  });

  it('shows a rename at once and keeps it when the core accepts', async () => {
    const fake = fakeBridge(fixtureState());
    const store = new HuddleStore(fake.bridge);
    store.start();
    await flush();
    const pending = store.rename(KEYS.core, 'Ingest lead');
    const agent = fixtureState().agents[KEYS.core];
    if (!agent) throw new Error('fixture');
    expect(displayName(agent, store.getSnapshot().renames)).toBe('Ingest lead');
    await pending;
    expect(fake.command).toHaveBeenCalledWith({ type: 'agent.rename', agentKey: KEYS.core, name: 'Ingest lead' });
    expect(displayName(agent, store.getSnapshot().renames)).toBe('Ingest lead');
  });

  it('reverts a rename the core refuses', async () => {
    const store = new HuddleStore(fakeBridge(fixtureState(), { ok: false, code: 'invalid', message: 'no' }).bridge);
    store.start();
    await flush();
    const result = await store.rename(KEYS.core, 'Nope');
    expect(result.ok).toBe(false);
    expect(store.getSnapshot().renames.has(KEYS.core)).toBe(false);
  });

  it('says what to do when the core cannot be reached', async () => {
    const fake = fakeBridge(fixtureState());
    fake.getState.mockRejectedValueOnce(new Error('gone'));
    const store = new HuddleStore(fake.bridge);
    store.start();
    await flush();
    expect(store.getSnapshot().error).toBe(CORE_UNREACHABLE);
  });
});
