// @vitest-environment happy-dom
/**
 * Answering a multi-select question on the card with real DOM events (S14 b): two check boxes, words in Other, Send.
 * Then a single-select question answered with typed words only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult, HuddleCommand } from '@huddle/shared';
import { InboxCard } from './components/Inbox.js';
import { settled } from './testing/arming.js';
import { byText, click, flush, mount, type, type Mounted } from './testing/dom.js';
import { interactState, MULTI, NOW, questionItem, SINGLE } from './testing/interact-fixture.js';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function recorder() {
  const sent: HuddleCommand[] = [];
  const onCommand = (c: HuddleCommand): Promise<CommandResult> => {
    sent.push(c);
    return Promise.resolve({ ok: true });
  };
  return { sent, onCommand };
}

describe('answering on the card', () => {
  it('multi-select: two picks and own words go out as a list plus other', async () => {
    const { sent, onCommand } = recorder();
    const item = questionItem(MULTI);
    mounted = await mount(
      settled(
        <InboxCard
          state={interactState({ inbox: [item] })}
          item={item}
          renames={new Map()}
          onCommand={onCommand}
          now={NOW}
        />,
      ),
    );
    const root = mounted.container;
    const send = () => byText(root, 'button', 'Send');
    expect(send()?.getAttribute('aria-disabled')).toBe('true');
    await click(byText(root, 'button', 'Fixes'));
    await click(byText(root, 'button', 'Features'));
    expect(byText(root, 'button', 'Fixes')?.getAttribute('aria-pressed')).toBe('true');
    expect(byText(root, 'button', 'Features')?.getAttribute('aria-pressed')).toBe('true');
    await type(root.querySelector('.question-other'), 'Docs');
    await click(send());
    await flush();
    expect(sent).toEqual([
      {
        type: 'question.answer',
        requestId: MULTI.requestId,
        answers: { 'Which sections?': ['Features', 'Fixes'] },
        other: { 'Which sections?': 'Docs' },
      },
    ]);
  });

  it('single-select: typed words replace the picked option', async () => {
    const { sent, onCommand } = recorder();
    const item = questionItem(SINGLE);
    mounted = await mount(
      settled(
        <InboxCard
          state={interactState({ inbox: [item] })}
          item={item}
          renames={new Map()}
          onCommand={onCommand}
          now={NOW}
        />,
      ),
    );
    const root = mounted.container;
    await click(byText(root, 'button', 'Friendly'));
    await type(root.querySelector('.question-other'), 'Warm but short');
    expect(byText(root, 'button', 'Friendly')?.getAttribute('aria-pressed')).toBe('false');
    await click(byText(root, 'button', 'Send'));
    await flush();
    const question = SINGLE.questions[0]?.question ?? '';
    expect(sent).toEqual([
      { type: 'question.answer', requestId: SINGLE.requestId, answers: {}, other: { [question]: 'Warm but short' } },
    ]);
  });
});
