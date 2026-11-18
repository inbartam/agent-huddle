/**
 * Arming delay (security review, 2026-11-14): when one request resolves, the next can mount in the same spot, so the
 * second click of a double-click must not answer it. A request card ignores presses, pointer and keyboard alike, for
 * ARMING_MS after it is first shown or after its item changes. Timing with an injected clock (view/arming.ts) and the
 * card as drawn (components/Arming.tsx through the shared InboxCard).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTROL_REASONS } from '@huddle/shared';
import { ArmingContext } from './components/Arming.js';
import { InboxCard } from './components/Inbox.js';
import { clockFrom } from './testing/arming.js';
import { approvalItem, interactState, NOW, questionItem } from './testing/interact-fixture.js';
import { approvalShortcut, ARMING_MS, armControl, isArmed, JUST_ARRIVED, pressWhenArmed } from './view/arming.js';
import { itemControls } from './view/inbox.js';

const ok = () => Promise.resolve({ ok: true as const });
const ON = { enabled: true, reason: null };

describe('arming timing', () => {
  it('takes presses only once the card has been shown for the arming time', () => {
    expect(ARMING_MS).toBeGreaterThan(500); // longer than the Windows double-click time
    expect(isArmed(1000, 1000)).toBe(false);
    expect(isArmed(1000, 1000 + ARMING_MS - 1)).toBe(false);
    expect(isArmed(1000, 1000 + ARMING_MS)).toBe(true);
    expect(isArmed(1000, 1000, 0)).toBe(true);
  });

  it('a double-click across two requests answers only the first', () => {
    const sent: string[] = [];
    // Request 1 has been on screen for a while; the first click allows it.
    const first = 0;
    expect(pressWhenArmed(first, 2_000, ARMING_MS, () => sent.push('req-1'))).toBe(true);
    // It resolves ~100 ms later and request 2 mounts in the same spot; the second click lands 200 ms after that.
    const nextShownAt = 2_100;
    expect(pressWhenArmed(nextShownAt, 2_300, ARMING_MS, () => sent.push('req-2'))).toBe(false);
    expect(sent).toEqual(['req-1']);
    // A deliberate click after the arming time does answer it.
    expect(pressWhenArmed(nextShownAt, nextShownAt + ARMING_MS, ARMING_MS, () => sent.push('req-2'))).toBe(true);
    expect(sent).toEqual(['req-1', 'req-2']);
  });

  it('draws an on control as off with the reason, and keeps an off control’s own reason', () => {
    expect(armControl(ON, false)).toEqual({ enabled: false, reason: JUST_ARRIVED });
    expect(armControl(ON, true)).toBe(ON);
    const notConnected = { enabled: false, reason: CONTROL_REASONS.notConnected };
    expect(armControl(notConnected, false)).toBe(notConnected);
  });

  it('keyboard shortcuts do nothing while the card is not armed, and work after', () => {
    const raw = itemControls(interactState(), approvalItem());
    const drawn = (armed: boolean) => ({
      approve: armControl(raw.approve, armed),
      deny: armControl(raw.deny, armed),
      passThrough: armControl(raw.passThrough, armed),
    });
    for (const key of ['a', 'A', 'd', 't']) expect(approvalShortcut(key, drawn(false))).toBeNull();
    expect(approvalShortcut('a', drawn(true))).toBe('allow');
    expect(approvalShortcut('d', drawn(true))).toBe('deny');
    expect(approvalShortcut('t', drawn(true))).toBe('pass');
    expect(approvalShortcut('x', drawn(true))).toBeNull();
  });
});

function approvalCard(clock: () => number): string {
  return renderToStaticMarkup(
    <ArmingContext value={{ ms: ARMING_MS, clock }}>
      <InboxCard state={interactState()} item={approvalItem()} renames={new Map()} onCommand={ok} now={NOW} />
    </ArmingContext>,
  );
}

function buttonNamed(html: string, label: string): string {
  return (
    [...html.matchAll(/<button[^>]*>.*?<\/button>/gs)].map((m) => m[0]).find((b) => b.includes(`>${label}<`)) ?? ''
  );
}

describe('a request card as drawn', () => {
  it('shows a freshly mounted request with its buttons off and says why; no shortcut is offered yet', () => {
    const html = approvalCard(clockFrom(5_000, 5_100));
    for (const label of ['Allow', 'Deny…', 'Pass to terminal']) {
      const b = buttonNamed(html, label);
      expect(b).toContain('aria-disabled="true"');
      expect(b).toContain(`title="${JUST_ARRIVED}"`);
      expect(b).not.toContain('aria-keyshortcuts');
    }
    // The brief delay shows on the buttons only: no reason line appears and then jumps away.
    expect(html).not.toContain(`<p class="card-reason">${JUST_ARRIVED}</p>`);
  });

  it('leaves a request that has been on screen longer than the arming time alone', () => {
    const html = approvalCard(clockFrom(5_000, 5_000 + ARMING_MS + 1));
    expect(buttonNamed(html, 'Allow')).not.toContain('aria-disabled');
    expect(buttonNamed(html, 'Allow')).toContain('aria-keyshortcuts="A"');
  });

  it('arms a question card the same way: picks, Send and Answer in terminal', () => {
    const html = renderToStaticMarkup(
      <ArmingContext value={{ ms: ARMING_MS, clock: clockFrom(5_000, 5_100) }}>
        <InboxCard state={interactState()} item={questionItem()} renames={new Map()} onCommand={ok} now={NOW} />
      </ArmingContext>,
    );
    const buttons = [...html.matchAll(/<button[^>]*>.*?<\/button>/gs)].map((m) => m[0]);
    const options = buttons.filter((b) => b.includes('option'));
    expect(options.length).toBeGreaterThan(0);
    for (const b of options) expect(b).toContain(`title="${JUST_ARRIVED}"`);
    expect(buttonNamed(html, 'Answer in terminal')).toContain(`title="${JUST_ARRIVED}"`);
  });
});
