/**
 * Helpers for interaction tests in happy-dom (files that start with `// @vitest-environment happy-dom`; every other
 * renderer test stays in node with static renders). Mount with React's `act`, send real DOM events, and read what the
 * user would see. A fake bridge records every command and query and answers them as the test says.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CommandResult, HuddleCommand, HuddleQuery, HuddleState, QueryResult } from '@huddle/shared';
import type { HuddleBridge } from '../../../preload/api.js';
import { HuddleStore } from '../store.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  root: Root;
  render: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return {
    container,
    root,
    render: async (next) => {
      await act(async () => {
        root.render(next);
        await Promise.resolve();
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
    },
  };
}

/** Let pending promises (a command's answer, a query) settle inside act. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
}

/** Wait real time inside act (a debounce). */
export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click');
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

export async function key(
  el: Element | null | undefined,
  k: string,
  opts: { shiftKey?: boolean; ctrlKey?: boolean } = {},
): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to press a key on');
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
    await Promise.resolve();
  });
}

/** Type into a controlled input or textarea (React listens for `input`). */
export async function type(el: Element | null | undefined, value: string): Promise<void> {
  if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) throw new Error('not a text field');
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

export async function pointer(el: Element | null | undefined, kind: string, clientX: number): Promise<void> {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to point at');
  await act(async () => {
    el.dispatchEvent(new PointerEvent(kind, { clientX, pointerId: 1, bubbles: true }));
    await Promise.resolve();
  });
}

/** The first element matching `selector` whose trimmed text is `text`. */
export function byText(scope: ParentNode, selector: string, text: string): HTMLElement | null {
  for (const el of scope.querySelectorAll<HTMLElement>(selector)) if (el.textContent.trim() === text) return el;
  return null;
}

export interface FakeBridge {
  bridge: HuddleBridge;
  store: HuddleStore;
  commands: HuddleCommand[];
  queries: HuddleQuery[];
  setState: (state: HuddleState) => void;
}

/** A bridge over a fixed state; commands and queries are recorded and answered by the given functions. */
export async function fakeStore(
  initial: HuddleState,
  answer: (cmd: HuddleCommand) => Promise<CommandResult> = () => Promise.resolve({ ok: true }),
  query: (q: HuddleQuery) => Promise<QueryResult> = () =>
    Promise.resolve({ ok: false, code: 'unsupported', message: 'not in this test' }),
): Promise<FakeBridge> {
  let state = initial;
  const commands: HuddleCommand[] = [];
  const queries: HuddleQuery[] = [];
  const bridge: HuddleBridge = {
    getState: () => Promise.resolve(state),
    command: (cmd) => {
      commands.push(cmd);
      return answer(cmd);
    },
    getEvents: () => Promise.resolve([]),
    onEvents: () => () => undefined,
    query: (q) => {
      queries.push(q);
      return query(q);
    },
  };
  const store = new HuddleStore(bridge);
  await store.refresh();
  return {
    bridge,
    store,
    commands,
    queries,
    setState: (next) => {
      state = next;
    },
  };
}
