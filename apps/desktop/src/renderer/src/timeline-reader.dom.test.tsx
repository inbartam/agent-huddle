// @vitest-environment happy-dom
/**
 * The timeline reader: a long reply ("Turn ended") opens below the list when its row is clicked or Enter is pressed
 * on it, drawn from Markdown as text elements; markup in agent text stays text. Plus the Markdown parser itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { HuddleEvent } from '@huddle/shared';
import { Timeline } from './components/Timeline.js';
import { click, key, mount, type Mounted } from './testing/dom.js';
import { KEYS, SESSION, T0, toolEvents, XSS } from './testing/fixture.js';
import { parseInline, parseMarkdown } from './view/markdown.js';
import { hasMore, timelineRows } from './view/timeline.js';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const REPLY = [
  'The Huddle shows only the **last message** of each answer.',
  '',
  '## Steps',
  '1. Open the `Timeline` tab',
  '2. Click a **Turn ended** row',
  '',
  '| Item | Status |',
  '|---|---|',
  '| hooks | on |',
  '',
  '```ts',
  `const x = "${XSS}";`,
  '```',
].join('\n');

function turn(id: string, lastMessage: string, ts = T0 + 60_000): HuddleEvent {
  return { id, ts, type: 'turn.ended', sessionId: SESSION, agentKey: KEYS.core, source: 'hook', lastMessage };
}

const noop = () => undefined;

describe('timeline reader', () => {
  it('opens a long reply as formatted text and closes it again', async () => {
    const rows = timelineRows([...toolEvents(2), turn('t1', REPLY)], KEYS.core);
    mounted = await mount(<Timeline rows={rows} filter="all" onFilter={noop} loading={false} />);
    const root = mounted.container;
    expect(root.querySelector('.tl-reader')).toBeNull();

    const row = root.querySelector<HTMLElement>('.tl-row.has-more');
    // The one-line row drops the Markdown marks a reader would not see (2026-11-18); the reader draws them.
    expect(row?.textContent).toContain('The Huddle shows only the last message of each answer.');
    expect(row?.textContent).not.toContain('**');
    // Tool rows with nothing more to show are not clickable.
    expect(root.querySelectorAll('.tl-row.has-more')).toHaveLength(1);

    await click(row);
    const reader = root.querySelector('.tl-reader');
    expect(reader?.querySelector('strong')?.textContent).toBe('last message');
    expect(reader?.querySelector('h5')?.textContent).toBe('Steps');
    expect(reader?.querySelectorAll('ol li')).toHaveLength(2);
    expect(reader?.querySelector('.md-code')?.textContent).toBe('Timeline');
    expect(reader?.querySelector('td')?.textContent).toBe('hooks');
    // Agent markup is shown as characters, never parsed.
    expect(reader?.querySelector('pre')?.textContent).toContain(XSS);
    expect(reader?.querySelector('img')).toBeNull();
    expect(row?.getAttribute('aria-selected')).toBe('true');

    await click(row);
    expect(root.querySelector('.tl-reader')).toBeNull();
  });

  it('opens from the keyboard and closes with Close', async () => {
    const rows = timelineRows([turn('t1', 'line one\nline two')], KEYS.core);
    mounted = await mount(<Timeline rows={rows} filter="all" onFilter={noop} loading={false} />);
    const root = mounted.container;
    const row = root.querySelector<HTMLElement>('.tl-row.has-more');
    expect(row?.tabIndex).toBe(0);
    await key(row, 'Enter');
    expect(root.querySelector('.tl-reader .md-p')?.textContent).toBe('line one\nline two');
    const close = [...root.querySelectorAll('.tl-reader button')].find((b) => b.textContent === 'Close');
    await click(close);
    expect(root.querySelector('.tl-reader')).toBeNull();
  });

  it('closes when the open row is filtered out', async () => {
    const rows = timelineRows([...toolEvents(1), turn('t1', 'a\nb')], KEYS.core);
    mounted = await mount(<Timeline rows={rows} filter="all" onFilter={noop} loading={false} />);
    await click(mounted.container.querySelector('.tl-row.has-more'));
    expect(mounted.container.querySelector('.tl-reader')).not.toBeNull();
    await mounted.render(<Timeline rows={rows} filter="tool" onFilter={noop} loading={false} />);
    expect(mounted.container.querySelector('.tl-reader')).toBeNull();
  });

  it('a short one-line detail does not open', () => {
    const [row] = timelineRows([turn('t1', 'Done.')], KEYS.core);
    expect(row && hasMore(row)).toBe(false);
  });

  it('a long one-line reply opens, so its end can be read (owner, 2026-11-18)', () => {
    const long =
      'All four checks passed, the report is written, and the worktree is kept for your review before merging.';
    const [row] = timelineRows([turn('t1', long)], KEYS.core);
    expect(row && hasMore(row)).toBe(true);
  });
});

describe('parseMarkdown', () => {
  it('reads the blocks Claude uses', () => {
    expect(parseMarkdown(REPLY).map((b) => b.kind)).toEqual(['para', 'heading', 'list', 'table', 'code']);
  });

  it('keeps an unclosed fence (a clipped reply) as code to the end', () => {
    expect(parseMarkdown('Look:\n```\nline 1\nline 2')).toEqual([
      { kind: 'para', text: 'Look:' },
      { kind: 'code', lang: '', text: 'line 1\nline 2' },
    ]);
  });

  it('bullets, quotes, rules and list continuation lines', () => {
    expect(parseMarkdown('- a\n  more a\n- b\n\n> q\n\n---')).toEqual([
      { kind: 'list', ordered: false, start: 1, items: ['a\nmore a', 'b'] },
      { kind: 'quote', text: 'q' },
      { kind: 'rule' },
    ]);
  });

  it('a pipe in plain text is not a table without the separator line', () => {
    expect(parseMarkdown('a | b\nc')).toEqual([{ kind: 'para', text: 'a | b\nc' }]);
  });

  it('inline: code wins over bold, unmatched markers stay text', () => {
    expect(parseInline('run `a **b**` then **go** now **x')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'a **b**' },
      { kind: 'text', text: ' then ' },
      { kind: 'strong', text: 'go' },
      { kind: 'text', text: ' now **x' },
    ]);
  });
});
