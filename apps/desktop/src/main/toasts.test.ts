import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  type AgentNode,
  type AttentionItem,
  type HuddleEvent,
  type ToastSettings,
} from '@huddle/shared';
import { itemFromHash } from '../renderer/src/view/deep-link.js';
import { cannedState } from './canned-core.js';
import {
  SeenKeys,
  TOAST_BODY_MAX,
  TOAST_TITLE_MAX,
  TOASTS_PER_BATCH,
  createToastNotifier,
  electronShowToast,
  isItemIdFormat,
  mainUrlLinkingItem,
  planToasts,
  toastFor,
  toastText,
  type NotificationLike,
} from './toasts.js';

const state = cannedState();
const agents = state.agents;
const byKind = (kind: AttentionItem['kind']): AttentionItem => {
  const item = state.inbox.find((i) => i.kind === kind);
  if (!item) throw new Error(`no canned ${kind} item`);
  return item;
};
const off = (key: keyof ToastSettings) => ({
  toasts: { ...DEFAULT_USER_SETTINGS.toasts, [key]: false },
});
const ch = (code: number) => String.fromCharCode(code);
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing test value');
  return value;
}

/** A budget item as the budget detector words it (packages/core/src/detect/budget.ts). */
function budgetItem(): AttentionItem {
  return {
    id: 'budget:session:canned-session-0001:warning',
    kind: 'budget',
    severity: 'warning',
    agentKey: 'canned-session-0001',
    title: 'The session budget of Parser team is nearly used',
    detail: 'Tokens 82% of 200k, est. At the cap it pauses.',
    createdAt: 1000,
    resolvedAt: null,
  };
}

function turnEnded(over: Partial<HuddleEvent> = {}): HuddleEvent {
  return {
    id: 'ev-1',
    ts: 1000,
    sessionId: 'canned-session-0001',
    agentKey: 'canned-session-0001',
    source: 'hook',
    type: 'turn.ended',
    lastMessage: 'Done',
    backgroundAgentIds: [],
    ...over,
  } as HuddleEvent;
}

describe('toastFor: one toast per attention kind', () => {
  it('approval: who, and the tool with its one-line summary', () => {
    const t = toastFor(byKind('approval'), DEFAULT_USER_SETTINGS, agents);
    expect(t).toEqual({
      title: 'Write parser tests needs approval',
      body: 'Bash: npm test -- parser',
      itemId: 'approval:canned-req-1',
      agentKey: 'canned-session-0001::a-test-1',
      key: 'item:approval:canned-req-1',
    });
  });

  it('question: the first question', () => {
    const t = toastFor(byKind('question'), DEFAULT_USER_SETTINGS, agents);
    expect(t?.title).toBe('Draft the summary asked a question');
    expect(t?.body).toBe('Which tone should the release notes use?');
  });

  it('stuck, loop, conflict', () => {
    expect(toastFor(byKind('stuck'), DEFAULT_USER_SETTINGS, agents)?.title).toBe('Run the e2e suite looks stuck');
    expect(toastFor(byKind('loop'), DEFAULT_USER_SETTINGS, agents)?.title).toBe('Map token kinds may be in a loop');
    const c = toastFor(byKind('file_conflict'), DEFAULT_USER_SETTINGS, agents);
    expect(c?.title).toBe('File conflict: Rewrite tokenizer and Update parser docs');
    expect(c?.itemId).toBe(byKind('file_conflict').id);
  });

  it('done and error: a main agent finished or failed its turn; click selects the agent', () => {
    const done = toastFor(turnEnded(), DEFAULT_USER_SETTINGS, agents);
    expect(done).toMatchObject({
      title: 'Refactor the parser finished its turn',
      itemId: null,
      agentKey: 'canned-session-0001',
    });
    const failed = toastFor(
      { ...turnEnded(), type: 'turn.failed', error: 'API error 529' },
      DEFAULT_USER_SETTINGS,
      agents,
    );
    expect(failed).toMatchObject({ title: 'Refactor the parser failed', body: 'API error 529' });
    const item: AttentionItem = { ...byKind('stuck'), id: 'err:1', kind: 'error', detail: 'Crashed' };
    expect(toastFor(item, DEFAULT_USER_SETTINGS, agents)?.title).toBe('Run the e2e suite failed');
  });

  it('no toast for subagent turns, turns with background agents, other events, context_high or resolved items', () => {
    const sub = turnEnded({ agentKey: 'canned-session-0001::a-test-1' });
    expect(toastFor(sub, DEFAULT_USER_SETTINGS, agents)).toBeNull();
    expect(toastFor(turnEnded({ backgroundAgentIds: ['a1'] }), DEFAULT_USER_SETTINGS)).toBeNull();
    expect(toastFor({ ...turnEnded(), type: 'session.ended', reason: 'exit' })).toBeNull();
    expect(toastFor({ ...byKind('stuck'), kind: 'context_high' })).toBeNull();
    expect(toastFor({ ...byKind('approval'), resolvedAt: 5 })).toBeNull();
  });

  it('an attention.raised event toasts its item', () => {
    const event = { ...turnEnded(), type: 'attention.raised', item: byKind('loop') } as HuddleEvent;
    expect(toastFor(event, DEFAULT_USER_SETTINGS, agents)?.key).toBe(`item:${byKind('loop').id}`);
  });

  it.each([
    ['approval', () => byKind('approval')],
    ['question', () => byKind('question')],
    ['stuck', () => byKind('stuck')],
    ['loop', () => byKind('loop')],
    ['conflict', () => byKind('file_conflict')],
    ['doneOrError', () => turnEnded()],
    ['budget', () => budgetItem()],
  ] as const)('%s can be switched off', (key, source) => {
    expect(toastFor(source(), DEFAULT_USER_SETTINGS, agents)).not.toBeNull();
    expect(toastFor(source(), off(key), agents)).toBeNull();
  });

  it('a budget item toasts with the words of the budget detector and opens the item (F19)', () => {
    const t = toastFor(budgetItem(), DEFAULT_USER_SETTINGS, agents);
    expect(t).toEqual({
      title: 'The session budget of Parser team is nearly used',
      body: 'Tokens 82% of 200k, est. At the cap it pauses.',
      itemId: 'budget:session:canned-session-0001:warning',
      agentKey: 'canned-session-0001',
      key: 'item:budget:session:canned-session-0001:warning',
    });
  });

  it('an unknown agent is "An agent"', () => {
    expect(toastFor({ ...byKind('stuck'), agentKey: 'nobody' }, DEFAULT_USER_SETTINGS, agents)?.title).toBe(
      'An agent looks stuck',
    );
  });
});

describe('toast text is plain, one line and clipped', () => {
  it('removes control and bidi characters, collapses whitespace', () => {
    const raw = `rm${ch(0)} -rf${ch(0x1b)}[31m\n\t/  ${ch(0x202e)}gpj.exe`;
    expect(toastText(raw, 100)).toBe('rm -rf [31m / gpj.exe');
  });

  it('clips long titles and bodies with an ellipsis', () => {
    const long = 'x'.repeat(5000);
    const named: Record<string, AgentNode> = {
      ...agents,
      'canned-session-0001::a-test-1': { ...must(agents['canned-session-0001::a-test-1']), name: 'n'.repeat(500) },
    };
    const item: AttentionItem = {
      ...byKind('approval'),
      approval: { ...must(byKind('approval').approval), summary: long },
    };
    const t = toastFor(item, DEFAULT_USER_SETTINGS, named);
    expect(t?.title.length).toBeLessThanOrEqual(TOAST_TITLE_MAX);
    expect(t?.body.length).toBe(TOAST_BODY_MAX);
    expect(t?.body.endsWith('…')).toBe(true);
  });

  it('markup stays text (Electron escapes it for the toast XML)', () => {
    const item: AttentionItem = { ...byKind('stuck'), detail: '<toast><b>x</b></toast>' };
    expect(toastFor(item)?.body).toBe('<toast><b>x</b></toast>');
  });
});

describe('planToasts: no storms', () => {
  const since = 0;
  const inbox = state.inbox.map((i) => ({ ...i, createdAt: 10 }));

  it('the same item toasts once, whether seen in the inbox or as an event', () => {
    const seen = new SeenKeys();
    const one = { ...state, inbox: [must(inbox[0])] };
    const raised = { ...turnEnded(), ts: 10, type: 'attention.raised', item: inbox[0] } as HuddleEvent;
    expect(planToasts({ batch: [raised], state: one, settings: DEFAULT_USER_SETTINGS, since }, seen)).toHaveLength(1);
    expect(planToasts({ batch: [raised], state: one, settings: DEFAULT_USER_SETTINGS, since }, seen)).toHaveLength(0);
    expect(planToasts({ batch: [], state: one, settings: DEFAULT_USER_SETTINGS, since }, seen)).toHaveLength(0);
  });

  it(`at most ${String(TOASTS_PER_BATCH)} per batch, the rest folded into one, and never shown later`, () => {
    const seen = new SeenKeys();
    const many = { ...state, inbox };
    const first = planToasts({ batch: [], state: many, settings: DEFAULT_USER_SETTINGS, since }, seen);
    expect(first).toHaveLength(TOASTS_PER_BATCH);
    expect(first.at(-1)).toMatchObject({ title: `${String(inbox.length - 2)} more need you`, itemId: null });
    expect(planToasts({ batch: [], state: many, settings: DEFAULT_USER_SETTINGS, since }, seen)).toEqual([]);
  });

  it('history (before the app started) never toasts', () => {
    const seen = new SeenKeys();
    const old = planToasts(
      { batch: [turnEnded({ ts: 5 })], state, settings: DEFAULT_USER_SETTINGS, since: 1e15 },
      seen,
    );
    expect(old).toEqual([]);
  });

  it('forgets the oldest keys past its bound', () => {
    const seen = new SeenKeys(2);
    seen.add('a');
    seen.add('b');
    seen.add('c');
    expect([seen.has('a'), seen.has('b'), seen.has('c')]).toEqual([false, true, true]);
  });
});

describe('the notifier adapter', () => {
  it('shows each new toast once and reports the click', () => {
    const shown: string[] = [];
    const clicks: string[] = [];
    const live = { ...state, inbox: [{ ...byKind('approval'), createdAt: 100 }] };
    const notify = createToastNotifier({
      getState: () => live,
      getSettings: () => DEFAULT_USER_SETTINGS,
      now: () => 50,
      show: (t, onClick) => {
        shown.push(t.title);
        onClick();
      },
      onClick: (t) => clicks.push(t.itemId ?? ''),
    });
    notify([]);
    notify([]);
    expect(shown).toEqual(['Write parser tests needs approval']);
    expect(clicks).toEqual(['approval:canned-req-1']);
  });

  it('keeps Notifications referenced until clicked, and skips when unsupported', () => {
    const handlers = new Map<string, () => void>();
    const show = vi.fn();
    const n: NotificationLike = {
      on: (event, listener) => handlers.set(event, listener),
      show,
    };
    const create = vi.fn(() => n);
    const onClick = vi.fn();
    const t = must(toastFor(byKind('stuck')));
    electronShowToast({ isSupported: () => false, create })(t, onClick);
    expect(create).not.toHaveBeenCalled();
    electronShowToast({ isSupported: () => true, create })(t, onClick);
    expect(create).toHaveBeenCalledWith({ title: t.title, body: t.body, silent: false });
    expect(show).toHaveBeenCalled();
    handlers.get('click')?.();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('#item= link from main', () => {
  const current = 'file:///C:/app/out/renderer/index.html?view=main#agent=x';

  it('round-trips through the renderer parser, including detector ids with paths', () => {
    for (const id of state.inbox.map((i) => i.id)) {
      const url = mainUrlLinkingItem(current, id);
      expect(url).not.toBeNull();
      const hash = new URL(must(url)).hash;
      expect(itemFromHash(hash)).toBe(id);
    }
  });

  it('refuses malformed ids', () => {
    for (const id of ['', 'a'.repeat(5000), `a${ch(10)}b`, `x${ch(0x202e)}y`]) {
      expect(isItemIdFormat(id)).toBe(false);
      expect(mainUrlLinkingItem(current, id)).toBeNull();
    }
    expect(mainUrlLinkingItem('not a url', 'approval:1')).toBeNull();
  });
});
