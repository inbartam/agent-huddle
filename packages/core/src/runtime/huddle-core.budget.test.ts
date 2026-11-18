/**
 * HuddleCore + budgets end to end over real HTTP (M4 WP5, F19): `budget.set` is validated and written as an event,
 * the budget detector runs on live hooks and on the timer, and an exceeded pause budget pauses the agent through the
 * M3 path (control.applied with source huddle, then the next PreToolUse is held). The clock is injected, so minute
 * budgets run out without waiting.
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentKey, selectBudgetPaused, type HuddleEvent } from '@huddle/shared';
import { budgetOverItemId, budgetWarningItemId } from '../detect/index.js';
import { payloads } from '../test/broker-sim.js';
import { BUDGET_SESSION_ID, HuddleCore, type HuddleCoreDeps } from './huddle-core.js';

const TOKEN = 'test-token-0123456789';
const MAIN = agentKey('session-1');
const MIN = 60_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function sendHook(port: number, payload: Record<string, unknown>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/huddle/hooks/${String(payload.hook_event_name)}`,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'x-huddle-token': TOKEN,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

/** One OTLP logs batch with one `api_request` (shape from fixtures/single-agent.jsonl); `cost` null: no cost_usd. */
function apiRequest(sessionId: string, requestId: string, cost: number | null): unknown {
  const s = (key: string, v: string) => ({ key, value: { stringValue: v } });
  const i = (key: string, v: number) => ({ key, value: { intValue: v } });
  return {
    resourceLogs: [
      {
        resource: { attributes: [s('service.name', 'claude-code'), s('service.version', '2.1.325')] },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.325' },
            logRecords: [
              {
                timeUnixNano: `${String(Date.now())}000000`,
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  s('session.id', sessionId),
                  s('event.name', 'api_request'),
                  s('event.timestamp', new Date().toISOString()),
                  s('model', 'claude-sonnet-5-5'),
                  i('input_tokens', 10),
                  i('output_tokens', 20),
                  i('cache_read_tokens', 0),
                  i('cache_creation_tokens', 0),
                  ...(cost === null ? [] : [{ key: 'cost_usd', value: { doubleValue: cost } }]),
                  s('request_id', requestId),
                  s('query_source', 'sdk'),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function postLogs(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/logs',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'x-huddle-token': TOKEN,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

interface Clock {
  t: number;
}

async function setup(clock: Clock, extra: Partial<HuddleCoreDeps> = {}, root?: string, seed = true) {
  root ??= await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-budget-'));
  const dir = root;
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const claudeDir = path.join(root, 'claude');
  await fsp.mkdir(claudeDir, { recursive: true });
  const forwarder = path.join(root, 'forwarder.mjs');
  await fsp.writeFile(forwarder, '// test forwarder\n');
  const core = new HuddleCore({
    dataDir: path.join(root, 'data'),
    claudeConfigDir: claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: forwarder,
    newToken: () => TOKEN,
    batchIntervalMs: 0,
    now: () => clock.t,
    ...extra,
  });
  cleanups.push(() => core.dispose());
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  if (seed) {
    expect((await sendHook(started.port, payloads.sessionStart())).status).toBe(200);
    expect((await sendHook(started.port, payloads.prompt())).status).toBe(200);
  }
  return { core, port: started.port, root };
}

function ofType<T extends HuddleEvent['type']>(
  core: HuddleCore,
  key: string,
  type: T,
): Extract<HuddleEvent, { type: T }>[] {
  return core.getEvents(key, 500).filter((e): e is Extract<HuddleEvent, { type: T }> => e.type === type);
}

describe('HuddleCore budgets', () => {
  it('budget.set: validates, files a session budget under the root, and a budget with no limit clears it', async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const { core } = await setup(clock);
    expect(
      await core.command({
        type: 'budget.set',
        agentKey: 'nobody',
        budget: { scope: 'agent', maxTokens: 10, warnAtFraction: 0.8, onExceed: 'pause' },
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(
      await core.command({
        type: 'budget.set',
        agentKey: MAIN,
        budget: { scope: 'agent', maxTokens: -1, warnAtFraction: 0.8, onExceed: 'pause' },
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await core.command({
        type: 'budget.set',
        agentKey: null,
        budget: { scope: 'session', maxTokens: 10, warnAtFraction: 0.8, onExceed: 'pause' },
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });

    const budget = { scope: 'session', maxTokens: 50_000, warnAtFraction: 0.8, onExceed: 'pause' } as const;
    expect(await core.command({ type: 'budget.set', agentKey: MAIN, budget })).toEqual({ ok: true });
    expect(core.getState().budgets).toEqual([{ scope: 'session', targetKey: MAIN, budget, setAt: clock.t }]);
    expect(ofType(core, MAIN, 'budget.set')).toEqual([
      expect.objectContaining({ source: 'user', scope: 'session', targetKey: MAIN, sessionId: 'session-1' }),
    ]);

    const cleared = { scope: 'session', warnAtFraction: 0.8, onExceed: 'pause' } as const;
    expect(await core.command({ type: 'budget.set', agentKey: MAIN, budget: cleared })).toEqual({ ok: true });
    expect(core.getState().budgets).toEqual([]);
  });

  it("'all' is read as 'overall': filed under its own session id, which never becomes a node", async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const { core } = await setup(clock);
    const result = await core.command({
      type: 'budget.set',
      agentKey: MAIN,
      budget: { scope: 'all', maxEstimatedCostUsd: 5, warnAtFraction: 0.8, onExceed: 'notify' },
    });
    expect(result).toEqual({ ok: true });
    const [entry] = core.getState().budgets ?? [];
    expect(entry).toMatchObject({ scope: 'overall', targetKey: null, budget: { scope: 'overall' } });
    expect(ofType(core, BUDGET_SESSION_ID, 'budget.set')).toHaveLength(1);
    expect(Object.keys(core.getState().agents)).not.toContain(BUDGET_SESSION_ID);
    expect(core.getState().rootKeys).toEqual([MAIN]);
  });

  it('an exceeded pause budget pauses the agent (source huddle) and the next PreToolUse is held; once only', async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const { core, port } = await setup(clock);
    const budget = { scope: 'session', maxMinutes: 1, warnAtFraction: 0.5, onExceed: 'pause' } as const;
    expect(await core.command({ type: 'budget.set', agentKey: MAIN, budget })).toEqual({ ok: true });
    clock.t += 2 * MIN;
    expect((await sendHook(port, payloads.prompt('more'))).status).toBe(200);

    const over = budgetOverItemId(`session:${MAIN}`);
    await vi.waitFor(() => {
      expect(core.getState().inbox.find((i) => i.id === over && i.resolvedAt === null)).toBeDefined();
    });
    const pauses = ofType(core, MAIN, 'control.applied').filter((e) => e.action === 'pause');
    expect(pauses).toEqual([expect.objectContaining({ source: 'huddle', detail: over })]);
    expect(core.getState().agents[MAIN]?.pausePending).toBe(true);
    const item = core.getState().inbox.find((i) => i.id === over);
    expect(item).toMatchObject({ kind: 'budget', severity: 'action_required', agentKey: MAIN });
    expect(item?.detail).toContain('Paused 1 agent.');

    // The pause is the M3 one: the next tool call is held.
    let answered = false;
    const held = sendHook(port, payloads.preToolUse('tu-1')).then((r) => {
      answered = true;
      return r;
    });
    await vi.waitFor(() => {
      expect(ofType(core, MAIN, 'hold.started')).toHaveLength(1);
    });
    expect(answered).toBe(false);

    // More events while the condition holds: nothing new.
    clock.t += MIN;
    expect(await core.command({ type: 'agent.resume', agentKey: MAIN })).toEqual({ ok: true });
    expect(await held).toEqual({ status: 200, body: '' });
    expect((await sendHook(port, payloads.prompt('again'))).status).toBe(200);
    expect(ofType(core, MAIN, 'control.applied').filter((e) => e.action === 'pause')).toHaveLength(1);
    expect(ofType(core, MAIN, 'attention.raised').filter((e) => e.item.id === over)).toHaveLength(1);
  });

  it('a session cost cap over telemetry: known cost_usd only, one warning, one exceed, one pause', async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const { core, port } = await setup(clock);
    const budget = { scope: 'session', maxEstimatedCostUsd: 1, warnAtFraction: 0.8, onExceed: 'pause' } as const;
    expect(await core.command({ type: 'budget.set', agentKey: MAIN, budget })).toEqual({ ok: true });
    const warn = budgetWarningItemId(`session:${MAIN}`);
    const over = budgetOverItemId(`session:${MAIN}`);
    const raisedIds = () => ofType(core, MAIN, 'attention.raised').map((e) => e.item.id);

    // Requests without cost_usd add nothing; 0.5 + 0.35 = 0.85: the warning.
    for (const [id, cost] of [
      ['r1', null],
      ['r2', 0.5],
      ['r3', null],
      ['r4', 0.35],
    ] as const) {
      expect(await postLogs(port, apiRequest('session-1', id, cost))).toBe(200);
    }
    await vi.waitFor(() => {
      expect(raisedIds()).toEqual([warn]);
    });
    expect(core.getState().inbox.find((i) => i.id === warn)?.detail).toContain('$0.85 of $1.00 estimated cost');

    // 1.05: over, the pause once; more spending changes nothing.
    expect(await postLogs(port, apiRequest('session-1', 'r5', 0.2))).toBe(200);
    await vi.waitFor(() => {
      expect(ofType(core, MAIN, 'control.applied').filter((e) => e.action === 'pause')).toHaveLength(1);
    });
    expect(await postLogs(port, apiRequest('session-1', 'r6', 0.5))).toBe(200);
    expect(await postLogs(port, apiRequest('session-1', 'r7', null))).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(raisedIds()).toEqual([warn, over]);
    expect(ofType(core, MAIN, 'control.applied').filter((e) => e.action === 'pause')).toEqual([
      expect.objectContaining({ source: 'huddle', detail: over }),
    ]);
    const item = core.getState().inbox.find((i) => i.id === over && i.resolvedAt === null);
    expect(item?.detail).toContain('$1.05 of $1.00 estimated cost');
    expect(item?.detail).toContain('Paused 1 agent.');
  });

  it('a minute budget runs out on the timer, with no event at all', async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const { core } = await setup(clock, { detectTickMs: 20 });
    const budget = { scope: 'overall', maxMinutes: 1, warnAtFraction: 0.5, onExceed: 'notify' } as const;
    expect(await core.command({ type: 'budget.set', agentKey: null, budget })).toEqual({ ok: true });
    clock.t += 2 * MIN;
    const over = budgetOverItemId('overall:*');
    await vi.waitFor(() => {
      expect(core.getState().inbox.find((i) => i.id === over && i.resolvedAt === null)).toBeDefined();
    });
    expect(core.getState().inbox.find((i) => i.id === over)?.detail).toContain('Notify only');
    expect(ofType(core, MAIN, 'control.applied')).toEqual([]);
  });

  it('after a restart, a budget already acted on is not acted on again', async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const first = await setup(clock);
    const budget = { scope: 'agent', maxMinutes: 1, warnAtFraction: 0.5, onExceed: 'pause' } as const;
    expect(await first.core.command({ type: 'budget.set', agentKey: MAIN, budget })).toEqual({ ok: true });
    clock.t += 2 * MIN;
    expect((await sendHook(first.port, payloads.prompt('more'))).status).toBe(200);
    await vi.waitFor(() => {
      expect(ofType(first.core, MAIN, 'control.applied').filter((e) => e.action === 'pause')).toHaveLength(1);
    });
    await first.core.dispose();

    clock.t += MIN;
    const second = await setup(clock, {}, first.root, false);
    expect((await sendHook(second.port, payloads.prompt('after restart'))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const pauses = ofType(second.core, MAIN, 'control.applied').filter((e) => e.action === 'pause');
    expect(pauses).toHaveLength(1); // the one from before the restart
    const over = budgetOverItemId(`agent:${MAIN}`);
    expect(ofType(second.core, MAIN, 'attention.raised').filter((e) => e.item.id === over)).toHaveLength(1);
  });
});

describe('HuddleCore budgets after the M4 runbook', () => {
  const SUB = agentKey('session-1', 'a1');
  const OVER = budgetOverItemId(`session:${MAIN}`);
  const keysOf = (core: HuddleCore) => selectBudgetPaused(core.getState(), OVER).map((n) => n.key);

  /** A session with one subagent, a 1-minute session budget that pauses, run past its cap. */
  async function pausedSession(clock: Clock) {
    const s = await setup(clock);
    expect((await sendHook(s.port, payloads.subagentStart('a1'))).status).toBe(200);
    const budget = { scope: 'session', maxMinutes: 1, warnAtFraction: 0.5, onExceed: 'pause' } as const;
    expect(await s.core.command({ type: 'budget.set', agentKey: MAIN, budget })).toEqual({ ok: true });
    clock.t += 2 * MIN;
    expect((await sendHook(s.port, payloads.prompt('more'))).status).toBe(200);
    await vi.waitFor(() => {
      expect(keysOf(s.core)).toEqual([MAIN, SUB].sort());
    });
    return s;
  }

  it('names every agent a budget paused (pausedBy), so Resume all can reach the subagent the root leaves paused', async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const { core } = await pausedSession(clock);
    expect(core.getState().inbox.find((i) => i.id === OVER)?.detail).toContain('Paused 2 agents.');

    // Cancel pause on the root alone (the runbook): the subagent stays paused, and still belongs to the budget.
    expect(await core.command({ type: 'agent.resume', agentKey: MAIN })).toEqual({ ok: true });
    expect(keysOf(core)).toEqual([SUB]);
    // Resume all is one agent.resume per remaining agent.
    expect(await core.command({ type: 'agent.resume', agentKey: SUB })).toEqual({ ok: true });
    expect(keysOf(core)).toEqual([]);
    expect(core.getState().agents[SUB]?.pausedBy).toBeNull();
  });

  it('raising the budget above usage resolves the over item, pauses nobody again, and leaves the paused agents to resume', async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const { core, port } = await pausedSession(clock);
    const raised = { scope: 'session', maxMinutes: 60, warnAtFraction: 0.8, onExceed: 'pause' } as const;
    expect(await core.command({ type: 'budget.set', agentKey: MAIN, budget: raised })).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(core.getState().inbox.find((i) => i.id === OVER)?.resolvedAt).not.toBeNull();
    });
    expect((await sendHook(port, payloads.prompt('after raise'))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(core.getState().inbox.filter((i) => i.id === OVER && i.resolvedAt === null)).toEqual([]);
    expect(ofType(core, MAIN, 'control.applied').filter((e) => e.action === 'pause')).toHaveLength(1);
    // Raising does not resume: the user still sees who is paused and resumes them.
    expect(keysOf(core)).toEqual([MAIN, SUB].sort());
    // The resolved item cannot be dismissed again.
    expect(await core.command({ type: 'attention.dismiss', itemId: OVER })).toMatchObject({
      ok: false,
      code: 'expired',
    });
  });

  it('attention.dismiss: refused while the budget holds agents paused; then dismissed, and not raised again for that setting', async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const s = await pausedSession(clock);
    const { core, port } = s;
    expect(await core.command({ type: 'attention.dismiss', itemId: OVER })).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    for (const key of [MAIN, SUB])
      expect(await core.command({ type: 'agent.resume', agentKey: key })).toEqual({ ok: true });

    expect(await core.command({ type: 'attention.dismiss', itemId: OVER })).toEqual({ ok: true });
    const dismissed = ofType(core, MAIN, 'attention.resolved').filter((e) => e.itemId === OVER);
    expect(dismissed).toEqual([expect.objectContaining({ source: 'user', reason: 'dismissed' })]);
    expect(core.getState().inbox.find((i) => i.id === OVER)).toMatchObject({ dismissed: true });

    // Still over the same setting: nothing new, no second pause.
    clock.t += MIN;
    expect((await sendHook(port, payloads.prompt('still over'))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(ofType(core, MAIN, 'attention.raised').filter((e) => e.item.id === OVER)).toHaveLength(1);
    expect(ofType(core, MAIN, 'control.applied').filter((e) => e.action === 'pause')).toHaveLength(1);

    // And after a restart (seedBudgetState reads the dismissed item as raised for this setting).
    await core.dispose();
    clock.t += MIN;
    const second = await setup(clock, {}, s.root, false);
    expect((await sendHook(second.port, payloads.prompt('after restart'))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(ofType(second.core, MAIN, 'attention.raised').filter((e) => e.item.id === OVER)).toHaveLength(1);
    expect(ofType(second.core, MAIN, 'control.applied').filter((e) => e.action === 'pause')).toHaveLength(1);
    expect(second.core.getState().inbox.find((i) => i.id === OVER)?.resolvedAt).not.toBeNull();
  });

  it('attention.dismiss: never an approval; unknown ids are not_found; bad input is invalid', async () => {
    const clock = { t: Date.parse('2026-11-14T10:00:00.000Z') };
    const { core, port } = await setup(clock);
    const held = sendHook(port, payloads.permission());
    let approvalId = '';
    await vi.waitFor(() => {
      const open = core.getState().inbox.find((i) => i.kind === 'approval' && i.resolvedAt === null);
      expect(open).toBeDefined();
      approvalId = open?.id ?? '';
    });
    expect(await core.command({ type: 'attention.dismiss', itemId: approvalId })).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    expect(core.getState().inbox.find((i) => i.id === approvalId)?.resolvedAt).toBeNull();
    expect(await core.command({ type: 'attention.dismiss', itemId: 'nope' })).toMatchObject({ code: 'not_found' });
    expect(await core.command({ type: 'attention.dismiss', itemId: '' })).toMatchObject({ code: 'invalid' });
    const requestId = core.getState().inbox.find((i) => i.id === approvalId)?.approval?.requestId ?? '';
    expect(await core.command({ type: 'approval.decide', requestId, decision: 'allow' })).toEqual({ ok: true });
    expect((await held).status).toBe(200);
  });
});
