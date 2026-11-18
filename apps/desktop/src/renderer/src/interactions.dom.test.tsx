// @vitest-environment happy-dom
/**
 * Interaction tests for the main window redesign (WP2, WP3), in happy-dom with real DOM events: Needs you's compact
 * cards (keys, arming, Open, Show less, the toast deep link, Recently handled, older items), the splitter, project
 * open state across a session ending, the guide's focus, Ask as a conversation, Make a rule from this…, and Message.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentKey,
  type AskAnswer,
  type AskPreview,
  type HuddleCommand,
  type HuddleQuery,
  type HuddleState,
} from '@huddle/shared';
import { ArmingContext } from './components/Arming.js';
import { Guide } from './components/Guide.js';
import { NeedsYou } from './components/NeedsYou.js';
import { Splitter } from './components/Shell.js';
import { SETTLED } from './testing/arming.js';
import { byText, click, fakeStore, flush, key, mount, pointer, type, wait, type Mounted } from './testing/dom.js';
import { SESSION, T0 } from './testing/fixture.js';
import { approvalItem, CONNECTED, IK, interactState, NOW, STUCK } from './testing/interact-fixture.js';
import { GUIDE_KEY } from './view/prefs.js';
import { MainView } from './views/MainView.js';

let mounted: Mounted | null = null;

beforeEach(() => {
  window.localStorage.clear();
  // The guide opens once by itself; these tests are about other things unless they say so.
  window.localStorage.setItem(GUIDE_KEY, '1');
  window.history.replaceState(null, '', '/');
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const identity = () => null;

async function needsYou(state: HuddleState, opts: { armed?: boolean; selectedId?: string | null } = {}) {
  const fake = await fakeStore(state);
  const agents: string[] = [];
  const arming = opts.armed === false ? { ms: 60_000, clock: () => 0 } : SETTLED;
  const el = (selectedId: string | null) => (
    <ArmingContext value={arming}>
      <NeedsYou
        store={fake.store}
        state={state}
        renames={new Map()}
        onAgent={(k) => {
          agents.push(k);
        }}
        selectedId={selectedId}
        identity={identity}
        now={NOW}
      />
    </ArmingContext>
  );
  mounted = await mount(el(opts.selectedId ?? null));
  return { fake, agents, rerender: (id: string | null) => mounted?.render(el(id)), container: mounted.container };
}

describe('Needs you: compact cards', () => {
  it('A allows, D denies (no note), O opens the full card and shows the agent; Show less goes back', async () => {
    const { fake, agents, container } = await needsYou(interactState({ inbox: [approvalItem()] }));
    const card = () => container.querySelector('.need-card');
    await key(card()?.querySelector('button'), 'a');
    await flush();
    expect(fake.commands).toContainEqual({ type: 'approval.decide', requestId: 'req-1', decision: 'allow' });
    await key(card()?.querySelector('button'), 'd');
    await flush();
    expect(fake.commands).toContainEqual({ type: 'approval.decide', requestId: 'req-1', decision: 'deny' });
    await key(card()?.querySelector('button'), 'o');
    expect(agents).toEqual([IK.tester]);
    expect(container.querySelector('.need-card')).toBeNull();
    expect(byText(container, 'button', 'Pass to terminal')).not.toBeNull();
    await click(byText(container, 'button', 'Show less'));
    expect(container.querySelector('.need-card')).not.toBeNull();
  });

  it('a card that just arrived ignores A and D (arming), O still opens', async () => {
    const { fake, container } = await needsYou(interactState({ inbox: [approvalItem()] }), { armed: false });
    const btn = container.querySelector('.need-card button');
    await key(btn, 'a');
    await key(btn, 'd');
    await click(byText(container, 'button', 'Allow'));
    await flush();
    expect(fake.commands).toEqual([]);
    await key(btn, 'o');
    expect(byText(container, 'button', 'Show less')).not.toBeNull();
  });

  it('a toast deep link opens and focuses its card once; Show less then works', async () => {
    const { container, rerender } = await needsYou(interactState({ inbox: [approvalItem(), STUCK] }), {
      selectedId: 'approval:req-1',
    });
    await flush();
    const full = container.querySelector('[data-item="approval:req-1"]');
    expect(full?.classList.contains('is-selected')).toBe(true);
    expect(document.activeElement).toBe(full);
    await click(byText(container, 'button', 'Show less'));
    expect(container.querySelector('.need-card[data-item="approval:req-1"]')).not.toBeNull();
    // The link is still set (the window clears it on the next pick); the card stays closed.
    await rerender('approval:req-1');
    expect(byText(container, 'button', 'Show less')).toBeNull();
  });

  it('nothing waiting: one quiet Recently handled line that opens the handled cards', async () => {
    const handled = approvalItem({ id: 'approval:old', resolvedAt: NOW - 5000 });
    const { container } = await needsYou(interactState({ inbox: [handled] }));
    expect(container.textContent).not.toContain('Needs you');
    const link = byText(container, 'button', 'Recently handled (1)');
    expect(link?.getAttribute('aria-expanded')).toBe('false');
    await click(link);
    expect(container.querySelector('[data-item="approval:old"]')).not.toBeNull();
    await click(byText(container, 'button', 'Hide recently handled'));
    expect(container.querySelector('[data-item="approval:old"]')).toBeNull();
  });

  it('items of a stale session sit behind the older toggle', async () => {
    const later = { ...CONNECTED, startedAt: NOW + 60_000 };
    const { container } = await needsYou(interactState({ inbox: [approvalItem(), STUCK], connection: later }));
    expect(container.querySelector('[data-item]')).toBeNull();
    await click(byText(container, 'button', '2 older (ended or from before the restart)'));
    expect(container.querySelectorAll('[data-item]')).toHaveLength(2);
    await click(byText(container, 'button', 'Hide 2 older items'));
    expect(container.querySelector('[data-item]')).toBeNull();
  });
});

describe('splitter', () => {
  it('keys and a drag change the width within 280–420, and aria-valuenow follows', async () => {
    const widths: number[] = [];
    function Host() {
      const [width, setWidth] = useState(312);
      return (
        <div>
          <div className="side" />
          <Splitter
            width={width}
            onWidth={(w) => {
              widths.push(w);
              setWidth(w);
            }}
          />
        </div>
      );
    }
    mounted = await mount(<Host />);
    const sep = mounted.container.querySelector('[role="separator"]');
    expect(sep?.getAttribute('aria-valuenow')).toBe('312');
    await key(sep, 'ArrowRight');
    expect(sep?.getAttribute('aria-valuenow')).toBe('328');
    await key(sep, 'ArrowLeft', { shiftKey: true });
    await key(sep, 'End');
    await key(sep, 'Home');
    expect(widths).toEqual([328, 288, 420, 280]);
    widths.length = 0;
    await pointer(sep, 'pointerdown', 100);
    await pointer(sep, 'pointermove', 150);
    await pointer(sep, 'pointermove', 400);
    await pointer(sep, 'pointerup', 400);
    // After pointerup the drag is over: a later move changes nothing.
    await pointer(sep, 'pointermove', 120);
    expect(widths).toEqual([330, 420]);
    widths.length = 0;
    await pointer(sep, 'pointerdown', 100);
    await pointer(sep, 'pointercancel', 100);
    await pointer(sep, 'pointermove', 50);
    expect(widths).toEqual([]);
  });
});

describe('guide focus', () => {
  it('focus stays on the primary button through the steps, Tab is trapped, Esc closes and returns focus', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    let closed = 0;
    mounted = await mount(
      <Guide
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    const c = mounted.container;
    expect(document.activeElement?.textContent).toBe('Next');
    await click(byText(c, 'button', 'Next'));
    expect(document.activeElement?.textContent).toBe('Next');
    await click(byText(c, 'button', 'Back'));
    // Back is gone on step 1: focus moved to Next, not to the page.
    expect(document.activeElement?.textContent).toBe('Next');
    // Tab from the last button wraps to the first.
    await key(document.activeElement, 'Tab');
    expect(document.activeElement?.textContent).toBe('Skip');
    await key(document.activeElement, 'Tab', { shiftKey: true });
    expect(document.activeElement?.textContent).toBe('Next');
    await click(byText(c, 'button', 'Next'));
    await click(byText(c, 'button', 'Next'));
    await click(byText(c, 'button', 'Next'));
    expect(document.activeElement?.textContent).toBe('Start using Huddle');
    await key(document.activeElement, 'Escape');
    expect(closed).toBe(1);
    await mounted.unmount();
    mounted = null;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

// --- the whole window ------------------------------------------------------------------------------------------

const ANSWER: AskAnswer = {
  text: 'the answer',
  model: 'claude-haiku-5-5',
  askedAt: T0,
  wallMs: 1000,
  apiMs: null,
  tokens: null,
  costUsd: null,
  sent: 'sent',
};
const PREVIEW: AskPreview = { text: 'x', bytes: 1, estTokens: 1, asOf: T0, truncated: false, parts: [] };

function askState(): HuddleState {
  return { ...interactState(), ask: { enabled: true, apiKeySet: false, busy: false } };
}

async function mainWindow(
  state: HuddleState,
  answer?: (cmd: HuddleCommand) => Promise<{ ok: true; ask?: unknown } | { ok: false; code: string; message: string }>,
) {
  const fake = await fakeStore(state, answer as never, (q: HuddleQuery) =>
    Promise.resolve(
      q.type === 'ask.preview'
        ? { ok: true as const, type: 'ask.preview' as const, preview: PREVIEW }
        : { ok: false as const, code: 'unsupported' as const, message: 'not here' },
    ),
  );
  mounted = await mount(<MainView store={fake.store} />);
  await flush();
  return fake;
}

const rail = (c: HTMLElement, label: string) => c.querySelector(`.rail-nav button[aria-label^="${label}"]`);

describe('main window', () => {
  it('Open on a compact card shows its session; Show less closes the card', async () => {
    await mainWindow(interactState({ inbox: [approvalItem()] }));
    const c = mounted?.container ?? document.body;
    await click(byText(c, '.need-card button', 'Open'));
    expect(c.querySelector('.session-view')).not.toBeNull();
    expect(c.querySelector('.session-head h1')?.textContent).toBe('Release notes');
    await click(byText(c, 'button', 'Show less'));
    expect(c.querySelector('.need-card')).not.toBeNull();
  });

  it('a project the user opened stays open when its last session ends', async () => {
    const fake = await mainWindow(interactState({ inbox: [] }));
    const c = mounted?.container ?? document.body;
    const head = () => c.querySelector('.project-head');
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    await click(head());
    await click(head());
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    const ended = interactState({ inbox: [] });
    for (const a of Object.values(ended.agents)) {
      a.status = 'done';
      a.endedAt = NOW;
    }
    fake.setState(ended);
    await fake.store.refresh();
    await flush();
    expect(c.querySelector('.side-earlier')?.textContent).toContain('Earlier · 1 ended session');
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
    // Never touched, an ended project would be closed: the choice is what keeps it open.
  });

  it('Make a rule from this… opens Rules with the safe draft; after Cancel, Rules opens with no draft', async () => {
    window.history.replaceState(null, '', `/#agent=${encodeURIComponent(IK.tester)}`);
    await mainWindow(interactState({ inbox: [approvalItem()] }));
    const c = mounted?.container ?? document.body;
    expect(c.querySelector('.why-block')).not.toBeNull();
    await click(byText(c, 'button', 'Make a rule from this…'));
    const name = c.querySelector<HTMLInputElement>('.rule-editor input[id$="-name"]');
    expect(name?.value).toBe('Ask before npm test');
    expect(c.querySelector<HTMLInputElement>('.rule-editor input[id$="-exact"]')?.checked).toBe(true);
    expect(byText(c, '[role="radio"]', 'ask me')?.getAttribute('aria-checked')).toBe('true');
    await click(byText(c, '.rule-editor button', 'Cancel'));
    expect(c.querySelector('.rule-editor')).toBeNull();
    await click(byText(c, '[role="tab"]', 'Templates'));
    await click(byText(c, '[role="tab"]', 'Rules'));
    expect(c.querySelector('.rule-editor')).toBeNull();
    await click(rail(c, 'Library'));
    expect(c.querySelector('.rule-editor')).toBeNull();
  });

  it('Message puts the focus in the main agent’s message box', async () => {
    window.history.replaceState(null, '', `/#agent=${encodeURIComponent(agentKey(SESSION))}`);
    await mainWindow(interactState({ inbox: [] }));
    const c = mounted?.container ?? document.body;
    await click(byText(c, '.session-actions button', 'Message'));
    await flush();
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    expect(document.activeElement?.closest('.detail-foot')).not.toBeNull();
    // The signal is one-shot: pick a subagent, then the lead again, and the box does not reopen or take the focus.
    const rows = () => Array.from(c.querySelectorAll<HTMLElement>('.sidebar [role="treeitem"]'));
    const lead = rows().find((r) => r.getAttribute('aria-level') === '1');
    const sub = rows().find((r) => r.getAttribute('aria-level') === '2');
    await click(sub);
    await click(lead);
    await flush();
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
  });

  it('Ask on Home: a follow-up sends the history to both the preview and the ask; Ask again; leaving cancels', async () => {
    let hold: ((v: { ok: true; ask: AskAnswer }) => void) | null = null;
    const fake = await mainWindow(askState(), (cmd) => {
      if (cmd.type === 'huddle.ask' && cmd.question === 'third?')
        return new Promise((r) => {
          hold = r;
        });
      return Promise.resolve(
        cmd.type === 'huddle.ask' ? { ok: true, ask: { ...ANSWER, text: `re ${cmd.question}` } } : { ok: true },
      );
    });
    const c = mounted?.container ?? document.body;
    const box = () => c.querySelector('.ask-card textarea');
    await type(box(), 'first?');
    await key(box(), 'Enter');
    await flush();
    expect(fake.commands.at(-1)).toEqual({ type: 'huddle.ask', question: 'first?' });
    expect(c.querySelector('.ask-card')?.textContent).toContain('re first?');

    await type(box(), 'second?');
    await wait(450);
    const preview = fake.queries.filter((q) => q.type === 'ask.preview').at(-1);
    expect(preview).toEqual({
      type: 'ask.preview',
      question: 'second?',
      history: [{ question: 'first?', answer: 're first?' }],
    });
    await key(box(), 'Enter');
    await flush();
    expect(fake.commands.at(-1)).toEqual({
      type: 'huddle.ask',
      question: 'second?',
      history: [{ question: 'first?', answer: 're first?' }],
    });

    await click(byText(c, '.ask-card button', 'Ask again'));
    await flush();
    // Ask again repeats the last question with the turns before it, and replaces its answer.
    expect(fake.commands.at(-1)).toEqual({
      type: 'huddle.ask',
      question: 'second?',
      history: [{ question: 'first?', answer: 're first?' }],
    });
    expect(c.querySelectorAll('.ask-card .ask-turn')).toHaveLength(2);

    await type(box(), 'third?');
    await key(box(), 'Enter');
    await flush();
    expect(hold).not.toBeNull();
    // Sent: the box is empty at once, while the answer is still on its way (owner, 2026-11-18).
    expect((box() as HTMLTextAreaElement | null)?.value).toBe('');
    await click(rail(c, 'History'));
    await flush();
    expect(fake.commands.at(-1)).toEqual({ type: 'ask.cancel' });
  });

  it('the guide opens by itself once and again from the rail', async () => {
    window.localStorage.removeItem(GUIDE_KEY);
    await mainWindow(interactState({ inbox: [] }));
    const c = mounted?.container ?? document.body;
    expect(c.querySelector('[role="dialog"]')).not.toBeNull();
    await click(byText(c, '.guide button', 'Skip'));
    expect(c.querySelector('[role="dialog"]')).toBeNull();
    expect(window.localStorage.getItem(GUIDE_KEY)).toBe('1');
    await click(rail(c, 'Guide'));
    expect(c.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
