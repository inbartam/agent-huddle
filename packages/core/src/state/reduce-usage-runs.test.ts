/** M2 exit criterion 1 over every recorded headless run in fixtures/runs: usage equals the raw api_request sums. */
import { describe, expect, it } from 'vitest';
import { agentKey, type TokenUsage } from '@huddle/shared';
import { rawApiRequests, sumRaw, type RawApiRequest, type RawUsageTotals } from '../test/raw-usage.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { listRunFixtures } from '../test/run-fixtures.js';
import { replay } from './reduce.js';

const MAIN_SOURCES = new Set(['sdk', 'repl_main_thread']);

/** Where a raw record must be counted: the agent's own usage, or the root's helperUsage. */
function expectedBucket(r: RawApiRequest): { key: string; helper: boolean } {
  const own =
    (r.querySource !== null && MAIN_SOURCES.has(r.querySource)) ||
    (r.querySource?.startsWith('agent:') === true && r.agentId !== null);
  return own ? { key: agentKey(r.sessionId, r.agentId), helper: false } : { key: agentKey(r.sessionId), helper: true };
}

function expectUsageEquals(actual: TokenUsage | undefined, raw: RawUsageTotals): void {
  expect(actual).toBeDefined();
  if (actual === undefined) return;
  expect(actual.requests).toBe(raw.records);
  expect(actual.inputTokens).toBe(raw.inputTokens);
  expect(actual.outputTokens).toBe(raw.outputTokens);
  expect(actual.cacheReadTokens).toBe(raw.cacheReadTokens);
  expect(actual.cacheCreationTokens).toBe(raw.cacheCreationTokens);
  expect(actual.estimatedCostUsd).toBeCloseTo(raw.costUsd, 9);
}

const runs = listRunFixtures();

describe.skipIf(runs.length === 0)('usage over recorded runs', () => {
  describe.each(runs.map((r) => r.file))('%s', (file) => {
    it('M2 exit criterion 1: each agent usage total equals the sum of its raw api_request records', () => {
      const raw = rawApiRequests(file);
      expect(raw.length).toBeGreaterThan(0);
      const state = replay(fixtureEvents(file));
      const groups = new Map<string, { own: RawApiRequest[]; helper: RawApiRequest[] }>();
      for (const r of raw) {
        const { key, helper } = expectedBucket(r);
        const group = groups.get(key) ?? { own: [], helper: [] };
        (helper ? group.helper : group.own).push(r);
        groups.set(key, group);
      }
      for (const [key, group] of groups) {
        const node = state.agents[key];
        expect(node, `no agent ${key}`).toBeDefined();
        if (group.own.length > 0) expectUsageEquals(node?.usage, sumRaw(group.own));
        if (group.helper.length > 0) expectUsageEquals(node?.helperUsage, sumRaw(group.helper));
      }
      for (const node of Object.values(state.agents)) {
        if (!groups.has(node.key)) expect(node.usage.requests).toBe(0);
      }
      expect(state.book.pendingUsage).toEqual({});
    });
  });
});
