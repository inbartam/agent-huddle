/** M2 exit criterion 3 gap tests: costs with no cost data, empty context, rate limits and ETA must never read as zero. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HuddleState } from '@huddle/shared';
import { ContextSection, UsageSection } from './components/Meters.js';
import { approxUsd, etaRange, percent } from './view/format.js';
import { progressWords } from './view/meters.js';
import { fixtureState, KEYS, meteredState, METERED_NOW, usageOf } from './testing/fixture.js';
import { WidgetBody } from './views/WidgetView.js';

function mainOf(s: HuddleState) {
  const a = s.agents[KEYS.main];
  if (!a) throw new Error('no main');
  return a;
}
const noop = () => undefined;
const widget = (state: HuddleState) =>
  renderToStaticMarkup(
    <WidgetBody
      state={state}
      error={null}
      renames={new Map()}
      opened={new Set()}
      onToggle={noop}
      onOpenMain={noop}
      now={METERED_NOW}
    />,
  );

/** Requests were recorded but none carried a cost: cost is unknown, tokens are not. */
function costlessState(): HuddleState {
  const usage = { ...usageOf(3, 0), requestsWithoutCost: 3 };
  return fixtureState({ main: { usage } });
}

describe('unknown cost (costMissing) is not shown as $0.00', () => {
  it('usage table cost cell', () => {
    const s = costlessState();
    const html = renderToStaticMarkup(<UsageSection state={s} agent={mainOf(s)} />);
    expect(html).not.toMatch(/\$0\.00/);
    expect(html).not.toMatch(/<\$0\.01/);
  });
  it('widget row cost', () => {
    const html = widget(costlessState());
    expect(html).not.toMatch(/\$0\.00/);
  });
});

describe('context and formatters', () => {
  it('context with tokens but no window shows unknown, no 0%', () => {
    const s = fixtureState({
      main: {
        context: {
          usedTokens: 5000,
          windowTokens: null,
          usedPct: null,
          compactions: 0,
          lastCompactedAt: null,
          loadedInstructions: [],
          measuredBy: 'telemetry',
        },
      },
    });
    const html = renderToStaticMarkup(<ContextSection agent={mainOf(s)} />);
    expect(html).toContain('window size unknown');
    expect(html).not.toContain('0%');
  });
  it('null/NaN never format as zero', () => {
    expect(approxUsd(null)).toBe('—');
    expect(percent(NaN)).toBe('—');
    expect(etaRange(null, 5000)).toBeNull();
  });
  it('a rate limit window with null pct shows — and no bar', () => {
    const base = meteredState();
    const html = widget({
      ...base,
      rateLimits: {
        fiveHourUsedPct: null,
        fiveHourResetsAt: null,
        sevenDayUsedPct: null,
        sevenDayResetsAt: null,
        measuredAt: 0,
      },
    });
    expect(html).not.toMatch(/rate-limit-pct">0%/);
    expect(html).not.toContain('rate-limit-bar');
  });
  it('no progress basis gives no fraction', () => {
    expect(progressWords(null, { status: 'working' }).fraction).toBeNull();
  });
});
