// @vitest-environment happy-dom
/**
 * Widget cards sort by need (2026-11-18), so when the top waiting card is answered it sinks and the next waiting card
 * moves into the spot the user just clicked. That card's request was armed long ago; keyed on its slot (`armKey`), it
 * is armed again, so the second click of a double-click cannot answer it (code review, 2026-11-18).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ArmingContext } from './components/Arming.js';
import { InboxCard } from './components/Inbox.js';
import { byText, mount, type Mounted } from './testing/dom.js';
import { approvalItem, interactState } from './testing/interact-fixture.js';
import { ARMING_MS, JUST_ARRIVED } from './view/arming.js';

const ok = () => Promise.resolve({ ok: true as const });
let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe('arming follows the card slot', () => {
  it('a request that moves into another slot ignores presses again for the arming time', async () => {
    let t = 1_000;
    const clock = () => t;
    const state = interactState();
    const item = approvalItem();
    const card = (slot: number) => (
      <ArmingContext value={{ ms: ARMING_MS, clock }}>
        <InboxCard state={state} item={item} renames={new Map()} onCommand={ok} armKey={`${item.id}@${String(slot)}`} />
      </ArmingContext>
    );
    mounted = await mount(card(1));
    const allow = () => byText(mounted?.container ?? document.body, 'button', 'Allow');
    // Shown long enough: armed.
    t += ARMING_MS + 50;
    await mounted.render(card(1));
    expect(allow()?.getAttribute('aria-disabled')).toBeNull();
    // Its neighbour was answered; it moves up into slot 0, under the pointer: off again, with the reason.
    await mounted.render(card(0));
    expect(allow()?.getAttribute('aria-disabled')).toBe('true');
    expect(allow()?.getAttribute('title')).toContain(JUST_ARRIVED);
    // A deliberate press after the arming time works.
    t += ARMING_MS + 50;
    await mounted.render(card(0));
    expect(allow()?.getAttribute('aria-disabled')).toBeNull();
  });
});
