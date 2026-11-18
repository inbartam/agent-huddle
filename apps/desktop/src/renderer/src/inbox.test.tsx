/**
 * The inbox (M3, F10 F21): which items show and in what order, the approval card's buttons and time limit, the
 * detector cards, how a handled item ended, the widget's pinned card, and that every command matches control.ts.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HuddleCommand, HuddleEvent } from '@huddle/shared';
import { InboxCard } from './components/Inbox.js';
import {
  approvalItem,
  CONFLICT,
  IK,
  interactState,
  MULTI,
  NOW,
  questionItem,
  STUCK,
} from './testing/interact-fixture.js';
import { SESSION, T0 } from './testing/fixture.js';
import {
  allowCommand,
  approvalLimit,
  countdown,
  denyCommand,
  dismissCommand,
  itemEnding,
  openItems,
  passThroughCommand,
  recentItems,
} from './view/inbox.js';
import { settled } from './testing/arming.js';
import { WidgetBody } from './views/WidgetView.js';

const ok = () => Promise.resolve({ ok: true as const });
const noop = () => undefined;

function card(item = approvalItem(), state = interactState(), extra: Partial<Parameters<typeof InboxCard>[0]> = {}) {
  return renderToStaticMarkup(
    settled(<InboxCard state={state} item={item} renames={new Map()} onCommand={ok} now={NOW} {...extra} />),
  );
}

/** The `<button …>label</button>` whose text contains `label`. */
function button(html: string, label: string): string {
  const m = new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, 's').exec(html);
  if (!m) throw new Error(`no button ${label} in ${html}`);
  return m[0];
}

describe('inbox order', () => {
  it('lists open items that need action first, oldest first, then warnings', () => {
    const ids = openItems(interactState()).map((i) => i.id);
    expect(ids).toEqual(['approval:req-1', 'question:q-1', 'question:q-2', STUCK.id, CONFLICT.id]);
  });

  it('keeps handled items out of the open list and shows the newest few as recent', () => {
    const handled = approvalItem({ resolvedAt: T0 + 30_000 });
    const state = interactState({ inbox: [handled, questionItem(), STUCK] });
    expect(openItems(state).map((i) => i.id)).toEqual(['question:q-1', STUCK.id]);
    expect(recentItems(state).map((i) => i.id)).toEqual(['approval:req-1']);
  });
});

describe('approval card', () => {
  it('shows the tool and summary with Allow, Deny and Pass to terminal on', () => {
    const html = card();
    expect(html).toContain('Bash');
    expect(html).toContain('npm test -- parser');
    for (const label of ['Allow', 'Deny…', 'Pass to terminal']) {
      expect(button(html, label)).not.toContain('aria-disabled');
    }
    expect(button(html, 'Allow')).toContain('aria-keyshortcuts="A"');
  });

  it('labels the time limit as an estimate, and unknown as unknown', () => {
    expect(card()).toContain('~9:00 left, est.');
    expect(approvalLimit(null, NOW).text).toBe('time limit unknown');
    expect(approvalLimit(T0, NOW).text).toBe('time limit reached, est.');
    expect(countdown(null)).toBe('—');
    expect(countdown(582_000)).toBe('9:42');
  });

  it('builds the exact approval commands', () => {
    const allow: HuddleCommand = { type: 'approval.decide', requestId: 'req-1', decision: 'allow' };
    expect(allowCommand('req-1')).toEqual(allow);
    expect(denyCommand('req-1', '   ')).toEqual({ type: 'approval.decide', requestId: 'req-1', decision: 'deny' });
    expect(denyCommand('req-1', ' use pnpm ')).toEqual({
      type: 'approval.decide',
      requestId: 'req-1',
      decision: 'deny',
      message: 'use pnpm',
    });
    expect(passThroughCommand('req-1')).toEqual({ type: 'approval.passThrough', requestId: 'req-1' });
  });
});

describe('detector cards', () => {
  it('shows the detail, the other agents of a conflict, and Dismiss', () => {
    const html = card(CONFLICT);
    expect(html).toContain('file conflict');
    expect(html).toContain('Two agents edited src\\a.ts in the last 10 min.');
    expect(html).toContain('Summary');
    expect(button(html, 'Dismiss')).not.toContain('aria-disabled');
    expect(card(STUCK)).toContain('looks stuck');
    expect(dismissCommand(STUCK.id)).toEqual({ type: 'attention.dismiss', itemId: STUCK.id });
  });
});

describe('how a handled item ended', () => {
  const base = { sessionId: SESSION, source: 'huddle' as const, ts: T0 + 30_000 };

  it('reads a deny with its note from the events', () => {
    const events: HuddleEvent[] = [
      {
        ...base,
        id: 'e1',
        agentKey: IK.tester,
        type: 'approval.resolved',
        requestId: 'req-1',
        outcome: 'denied',
        by: 'user',
        policyRuleId: null,
        message: 'use pnpm',
      },
    ];
    const item = approvalItem({ resolvedAt: T0 + 30_000 });
    expect(itemEnding(item, events)?.text).toBe('Denied from Huddle.');
    const html = card(item, interactState(), { events });
    expect(html).toContain('Denied from Huddle.');
    expect(html).toContain('use pnpm');
    expect(html).not.toContain('Allow</button>');
  });

  it('says a question was handed to the terminal, and only the time when the events do not say', () => {
    const item = questionItem(MULTI, { resolvedAt: T0 + 30_000 });
    const events: HuddleEvent[] = [
      { ...base, id: 'e2', agentKey: IK.main, type: 'question.closed', requestId: 'q-2', outcome: 'passed_through' },
    ];
    expect(itemEnding(item, events)?.text).toBe('Handed to the terminal. Answer it there.');
    expect(itemEnding(item, [])).toBeNull();
    expect(card(item, interactState(), { events: [] })).toContain('Handled at');
  });
});

describe('widget inline request', () => {
  it('shows the top approval inline in its session card, with its buttons, at widget size', () => {
    const html = renderToStaticMarkup(
      settled(
        <WidgetBody
          state={interactState()}
          error={null}
          renames={new Map()}
          opened={new Set()}
          onToggle={noop}
          onOpenMain={noop}
          onCommand={ok}
          now={NOW}
        />,
      ),
    );
    // Widget v2: the request renders inside its session's card (no pinned strip: every item has a card).
    expect(html).not.toContain('aria-label="Waiting on you"');
    expect(html).toContain('<div class="scard-request"><article class="card kind-approval is-compact is-inline"');
    expect(button(html, 'Allow')).not.toContain('aria-disabled');
    expect(button(html, 'Terminal')).toContain('aria-keyshortcuts="T"');
  });
});
