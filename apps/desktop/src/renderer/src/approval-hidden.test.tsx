/**
 * AX-01: an approval whose summary hides part of the command (a masked secret, or cut at the summary limit) carries a
 * plain warning line on the desktop cards. Allow stays available on the desktop.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InboxCard } from './components/Inbox.js';
import { CompactCard } from './components/NeedsYou.js';
import { APPROVAL, approvalItem, interactState, NOW } from './testing/interact-fixture.js';
import { settled } from './testing/arming.js';
import { HIDDEN_COMMAND_WORDS } from './view/inbox.js';

const ok = () => Promise.resolve({ ok: true as const });
const noop = () => undefined;
const HIDDEN = approvalItem({ approval: { ...APPROVAL, hidden: true } });

function inbox(item = HIDDEN): string {
  return renderToStaticMarkup(
    settled(<InboxCard state={interactState()} item={item} renames={new Map()} onCommand={ok} now={NOW} />),
  );
}

function compact(item = HIDDEN): string {
  return renderToStaticMarkup(
    settled(
      <CompactCard
        state={interactState()}
        item={item}
        renames={new Map()}
        onCommand={ok}
        onOpen={noop}
        onAgent={noop}
        who={null}
        now={NOW}
      />,
    ),
  );
}

describe('hidden part of an approval command (AX-01)', () => {
  it('uses the agreed words', () => {
    expect(HIDDEN_COMMAND_WORDS).toBe(
      "Part of this command is hidden (masked or too long). Check the full command in the agent's terminal before allowing.",
    );
  });

  it('shows the warning on the inbox card and keeps Allow', () => {
    const html = inbox();
    expect(html).toContain('Part of this command is hidden (masked or too long).');
    expect(html).toContain('Allow');
  });

  it('shows the warning on the compact Needs you card', () => {
    expect(compact()).toContain('Part of this command is hidden (masked or too long).');
  });

  it('shows it for an older summary with the mask marker', () => {
    const old = approvalItem({ approval: { ...APPROVAL, summary: 'API_KEY=<redacted> npm test' } });
    expect(inbox(old)).toContain('Part of this command is hidden');
  });

  it('shows nothing for a plain request', () => {
    expect(inbox(approvalItem())).not.toContain('Part of this command is hidden');
    expect(compact(approvalItem())).not.toContain('Part of this command is hidden');
  });
});
