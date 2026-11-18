/**
 * M1 exit criteria, checked through the real HuddleCore and its real HTTP server (WP12).
 *
 *  1. "Six nodes with the right parents, roles, names and statuses within 1 s of each change."
 *     A synthetic orchestrator with five subagents (one nested, two async) is POSTed hook by hook, the way
 *     Claude Code would send it. After each POST the tree must reach the expected shape, and the time from
 *     the POST to the state (and to the listener batch) is measured.
 *  2. "Quitting the Huddle mid-run does not disturb the session": dispose() during the run answers what is in
 *     flight, removes the hooks (telemetry kept) and leaves the port closed.
 *
 * Payload shapes are copied from fixtures/parallel-subagents.jsonl and fixtures/nested-subagents.jsonl. The live
 * halves (a real `claude` session, no error lines) need the owner and are not covered here.
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectTree, type HuddleEvent, type TreeNodeView } from '@huddle/shared';
import { isHuddleHook } from '../setup/install-hooks.js';
import { HuddleCore, silentLogger } from './huddle-core.js';
import { writeHuddleSettings } from './huddle-settings.js';
import { consentRecord } from '../test/consent.js';
import { readStoredLog } from '../test/stored-log.js';

const TOKEN = 'exit-criteria-token-0123456789';
const SESSION = 'orch-1';

interface Env {
  root: string;
  dataDir: string;
  claudeDir: string;
  cwd: string;
  settingsPath: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function makeEnv(): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-exit-'));
  const env: Env = {
    root,
    dataDir: path.join(root, 'data'),
    claudeDir: path.join(root, 'claude'),
    cwd: path.join(root, 'project'),
    settingsPath: path.join(root, 'claude', 'settings.json'),
  };
  await fsp.mkdir(env.claudeDir, { recursive: true });
  await fsp.mkdir(path.join(env.cwd, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(root, 'forwarder.mjs'), '// test forwarder\n');
  await fsp.writeFile(
    path.join(env.cwd, '.claude', 'agents', 'explore.md'),
    '---\nname: Explore\ndescription: Finds files in the project\n---\nBody\n',
  );
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return env;
}

interface Running {
  env: Env;
  core: HuddleCore;
  port: number;
  /** Time each event reached a listener minus its receive time (ms). */
  arrivals: { event: HuddleEvent; at: number }[];
}

async function startCore(opts: { cwdDep?: boolean } = {}): Promise<Running> {
  const env = await makeEnv();
  await writeHuddleSettings(env.dataDir, consentRecord(env.claudeDir, env.settingsPath));
  const core = new HuddleCore({
    dataDir: env.dataDir,
    claudeConfigDir: env.claudeDir,
    cwd: opts.cwdDep === false ? null : env.cwd,
    userAgentsDir: path.join(env.claudeDir, 'agents'),
    port: 0,
    forwarderSource: path.join(env.root, 'forwarder.mjs'),
    logger: silentLogger,
    newToken: () => TOKEN,
  });
  cleanups.push(() => core.dispose());
  const arrivals: Running['arrivals'] = [];
  core.onEvents((batch) => {
    const at = Date.now();
    for (const event of batch) arrivals.push({ event, at });
  });
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  return { env, core, port: started.port, arrivals };
}

function post(port: number, event: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/huddle/hooks/${event}`,
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

// ---------------------------------------------------------------------------------------------------------------------
// Payload builders (shapes copied from the recorded fixtures)
// ---------------------------------------------------------------------------------------------------------------------

function base(env: Env, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: path.join(env.cwd, '.claude', 'projects', 'p', `${SESSION}.jsonl`),
    cwd: env.cwd,
    prompt_id: 'prompt-1',
    ...extra,
  };
}

const sessionStart = (env: Env): Record<string, unknown> =>
  base(env, { hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' });

function agentCall(
  env: Env,
  o: {
    toolUseId: string;
    type: string;
    description: string;
    background: boolean;
    caller?: { id: string; type: string };
  },
): Record<string, unknown> {
  return base(env, {
    permission_mode: 'default',
    ...(o.caller ? { agent_id: o.caller.id, agent_type: o.caller.type } : {}),
    effort: { level: 'medium' },
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: {
      description: o.description,
      prompt: '(scrubbed text)',
      subagent_type: o.type,
      run_in_background: o.background,
    },
    tool_use_id: o.toolUseId,
  });
}

const subagentStart = (env: Env, id: string, type: string): Record<string, unknown> =>
  base(env, { agent_id: id, agent_type: type, hook_event_name: 'SubagentStart' });

function agentResult(
  env: Env,
  o: {
    toolUseId: string;
    type: string;
    description: string;
    background: boolean;
    agentId: string;
    caller?: { id: string; type: string };
  },
): Record<string, unknown> {
  return base(env, {
    permission_mode: 'default',
    ...(o.caller ? { agent_id: o.caller.id, agent_type: o.caller.type } : {}),
    effort: { level: 'medium' },
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input: {
      description: o.description,
      prompt: '(scrubbed text)',
      subagent_type: o.type,
      run_in_background: o.background,
    },
    tool_response: o.background
      ? { agentId: o.agentId, isAsync: true, status: 'async_launched', resolvedModel: 'claude-opus-5-5' }
      : { agentId: o.agentId, status: 'completed', resolvedModel: 'claude-opus-5-5' },
    tool_use_id: o.toolUseId,
    duration_ms: 20,
  });
}

const subagentStop = (env: Env, id: string, type: string): Record<string, unknown> =>
  base(env, {
    permission_mode: 'default',
    agent_id: id,
    agent_type: type,
    effort: { level: 'medium' },
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_transcript_path: path.join(env.cwd, 'subagents', `agent-${id}.jsonl`),
    last_assistant_message: '(scrubbed text)',
    background_tasks: [],
    session_crons: [],
  });

const mainStop = (env: Env, running: { id: string; type: string }[]): Record<string, unknown> =>
  base(env, {
    permission_mode: 'default',
    effort: { level: 'medium' },
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: '(scrubbed text)',
    background_tasks: running.map((a) => ({
      id: a.id,
      type: 'subagent',
      status: 'running',
      description: '(scrubbed text)',
      agent_type: a.type,
    })),
    session_crons: [],
  });

// ---------------------------------------------------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------------------------------------------------

interface Flat {
  id: string | null;
  parentId: string | null;
  role: string;
  name: string;
  status: string;
  link: string | null;
}

/** The visible tree flattened, keyed by agent id ("main" for the main agent). */
function flatTree(core: HuddleCore): Record<string, Flat> {
  const out: Record<string, Flat> = {};
  const sessions = selectTree(core.getState());
  const visit = (node: TreeNodeView, parent: string | null): void => {
    const id = node.agentId ?? 'main';
    out[id] = { id, parentId: parent, role: node.role, name: node.name, status: node.status, link: node.link };
    for (const child of node.children) visit(child, id);
  };
  for (const s of sessions) visit(s.root, null);
  return out;
}

const TEAM = [
  { id: 'agent-1', type: 'Explore', description: 'Map the repo', background: true },
  { id: 'agent-2', type: 'general-purpose', description: 'Plan the change', background: false },
  { id: 'agent-3', type: 'Plan', description: 'Draft the design', background: true },
  { id: 'agent-4', type: 'code-reviewer', description: 'Review the diff', background: false },
  // Nested: spawned by agent-2, not by the main agent.
  { id: 'agent-5', type: 'test-writer', description: 'Write the tests', background: false, parent: 'agent-2' },
] as const;

type Member = (typeof TEAM)[number];

function expectedNode(m: Member | 'main', status: string): Omit<Flat, 'link'> {
  if (m === 'main') return { id: 'main', parentId: null, role: 'main', name: 'main', status };
  const parentId = 'parent' in m ? m.parent : 'main';
  return { id: m.id, parentId, role: m.type, name: m.description, status };
}

function stripLink(flat: Record<string, Flat>): Record<string, Omit<Flat, 'link'>> {
  return Object.fromEntries(
    Object.entries(flat).map(([k, v]) => [
      k,
      { id: v.id, parentId: v.parentId, role: v.role, name: v.name, status: v.status },
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------------------------

describe('exit criterion 1: an orchestrator with five subagents through the real server', () => {
  it('builds six nodes with the right parents, roles, names and statuses within 1 s of each change', async () => {
    const run = await startCore();
    const { env, core, port } = run;
    const latencies: number[] = [];

    /** POST one hook, then wait until the tree equals `expected`; records the POST-to-state time. */
    async function step(
      label: string,
      event: string,
      payload: Record<string, unknown>,
      expected: Record<string, Omit<Flat, 'link'>>,
    ): Promise<void> {
      const t0 = performance.now();
      expect(await post(port, event, payload), label).toBe(200);
      await vi.waitFor(
        () => {
          expect(stripLink(flatTree(core)), label).toEqual(expected);
        },
        { timeout: 1000, interval: 2 },
      );
      latencies.push(performance.now() - t0);
    }

    const state: Record<string, Omit<Flat, 'link'>> = {};
    const set = (m: Member | 'main', status: string): void => {
      const node = expectedNode(m, status);
      state[node.id ?? 'main'] = node;
    };
    const snap = (): Record<string, Omit<Flat, 'link'>> => structuredClone(state);

    // 1. Session starts: one node.
    set('main', 'starting');
    await step('SessionStart', 'SessionStart', sessionStart(env), snap());

    // 2. Four calls from the main agent and one from agent-2; each Agent call then starts its subagent.
    for (const m of TEAM) {
      const caller = 'parent' in m ? { id: m.parent, type: 'general-purpose' } : undefined;
      const call = {
        toolUseId: `tool-${m.id}`,
        type: m.type,
        description: m.description,
        background: m.background,
        caller,
      };
      // PreToolUse(Agent) alone adds no node (the subagent is not running yet); the main agent is now working.
      set('main', 'working');
      const before = snap();
      await post(port, 'PreToolUse', agentCall(env, call));
      await new Promise((r) => setTimeout(r, 30));
      expect(stripLink(flatTree(core))).toEqual(before);

      set(m, 'working');
      await step(`SubagentStart ${m.id}`, 'SubagentStart', subagentStart(env, m.id, m.type), snap());
      // The Agent call returns: async ones immediately, sync ones only after the subagent stops (below).
      if (m.background) {
        await post(port, 'PostToolUse', agentResult(env, { ...call, agentId: m.id }));
      }
    }

    // Parents come from the Agent calls: the nested subagent hangs under agent-2.
    const flat = flatTree(core);
    expect(Object.keys(flat).sort()).toEqual(['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5', 'main']);
    expect(flat['agent-5']?.parentId).toBe('agent-2');

    // 3. Main stops its turn while the two async subagents still run: it is not idle.
    set('main', 'working');
    await step(
      'main Stop with background tasks',
      'Stop',
      mainStop(env, [
        { id: 'agent-1', type: 'Explore' },
        { id: 'agent-3', type: 'Plan' },
      ]),
      snap(),
    );

    // 4. Sync subagents finish (nested first), then their Agent calls return; async ones finish later.
    for (const id of ['agent-5', 'agent-2', 'agent-4', 'agent-1', 'agent-3']) {
      const m = TEAM.find((t) => t.id === id);
      if (!m) throw new Error('unknown');
      set(m, 'done');
      await step(`SubagentStop ${id}`, 'SubagentStop', subagentStop(env, id, m.type), snap());
      if (!m.background) {
        const caller = 'parent' in m ? { id: m.parent, type: 'general-purpose' } : undefined;
        await post(
          port,
          'PostToolUse',
          agentResult(env, {
            toolUseId: `tool-${m.id}`,
            type: m.type,
            description: m.description,
            background: false,
            agentId: m.id,
            caller,
          }),
        );
        // The result must not reopen or rename the node.
        await new Promise((r) => setTimeout(r, 30));
        expect(stripLink(flatTree(core))).toEqual(snap());
      }
    }

    // 5. Main stops again with nothing running: now it is idle.
    set('main', 'idle');
    await step('main Stop, nothing running', 'Stop', mainStop(env, []), snap());

    // The Agent results gave exact parent links for every subagent.
    const links = Object.fromEntries(Object.entries(flatTree(core)).map(([k, v]) => [k, v.link]));
    expect(links).toMatchObject({
      main: null,
      'agent-1': 'exact',
      'agent-2': 'exact',
      'agent-3': 'exact',
      'agent-4': 'exact',
      'agent-5': 'exact',
    });

    // Latency: POST to visible state, and receive time to listener batch.
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const max = sorted.at(-1) ?? 0;
    const listener = run.arrivals.map((a) => a.at - a.event.ts);
    const lSorted = [...listener].sort((a, b) => a - b);
    console.info(
      `[exit-criteria] POST->state: n=${String(sorted.length)} p50=${p50.toFixed(1)}ms max=${max.toFixed(1)}ms; ` +
        `receivedAt->listener: n=${String(listener.length)} p50=${String(lSorted[Math.floor(lSorted.length / 2)])}ms max=${String(lSorted.at(-1))}ms`,
    );
    expect(max).toBeLessThan(1000);
    expect(Math.max(...listener)).toBeLessThan(1000);
    expect(listener.length).toBeGreaterThan(10);
  }, 20_000);
});

describe('exit criterion 2: quitting the Huddle mid-run', () => {
  it('answers what is in flight, removes the hooks, keeps telemetry, and refuses later hooks', async () => {
    const run = await startCore();
    const { env, core, port } = run;
    expect(await post(port, 'SessionStart', sessionStart(env))).toBe(200);
    for (const m of TEAM.slice(0, 3)) {
      const call = { toolUseId: `tool-${m.id}`, type: m.type, description: m.description, background: m.background };
      await post(port, 'PreToolUse', agentCall(env, call));
      await post(port, 'SubagentStart', subagentStart(env, m.id, m.type));
    }
    await vi.waitFor(() => {
      expect(Object.keys(flatTree(core))).toHaveLength(4);
    });
    const before = JSON.parse(await fsp.readFile(run.env.settingsPath, 'utf8')) as {
      hooks?: Record<string, unknown[]>;
    };
    expect(Object.keys(before.hooks ?? {}).length).toBeGreaterThan(0);

    // A request is half sent when the user quits: it must still get its answer, not a reset.
    const text = JSON.stringify(
      agentCall(env, { toolUseId: 'tool-late', type: 'Plan', description: 'Late call', background: false }),
    );
    const status = new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/huddle/hooks/PreToolUse',
          method: 'POST',
          agent: false,
          headers: { 'content-length': Buffer.byteLength(text), 'x-huddle-token': TOKEN },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write(text.slice(0, 20));
      setTimeout(() => {
        void core.dispose();
        setTimeout(() => req.end(text.slice(20)), 50);
      }, 50);
    });
    expect(await status).toBe(200);
    const t0 = performance.now();
    await core.dispose();
    expect(performance.now() - t0).toBeLessThan(3000);

    // Hooks gone, telemetry env kept, nothing else in the user's file lost.
    const after = JSON.parse(await fsp.readFile(env.settingsPath, 'utf8')) as {
      hooks?: Record<string, { hooks?: Record<string, unknown>[] }[]>;
      env?: Record<string, string>;
    };
    const entries = Object.values(after.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks ?? []));
    expect(entries.some((h) => isHuddleHook(h))).toBe(false);
    expect(after.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`http://127.0.0.1:${String(port)}`);

    // The log kept everything received before quitting.
    const log = await readStoredLog(env.dataDir);
    expect(log.map((e) => e.type)).toContain('agent.started');

    // A hook sent after quit is refused at the socket: for Claude Code a non-blocking error (docs/INTEGRATION.md,
    // "Connection failure"), so the action proceeds.
    await expect(post(port, 'PostToolUse', { session_id: SESSION })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe('F2 role descriptions in the shape the desktop app runs with', () => {
  // The desktop passes cwd: null to HuddleCore (apps/desktop/src/main/core-config.ts). HuddleCore reads the
  // session root's cwd from state (set by SessionStart), so a project-level agent definition in the session's own
  // folder is described in the app too.
  it('describes a role defined in the session project folder when the app has no fixed cwd', async () => {
    const run = await startCore({ cwdDep: false });
    const { env, core, port } = run;
    await post(port, 'SessionStart', sessionStart(env));
    await post(
      port,
      'PreToolUse',
      agentCall(env, { toolUseId: 't1', type: 'Explore', description: 'Map it', background: false }),
    );
    await post(port, 'SubagentStart', subagentStart(env, 'agent-1', 'Explore'));
    await new Promise((r) => setTimeout(r, 300));
    const root = selectTree(core.getState())[0]?.root;
    expect(root?.children[0]?.roleDescription).toBe('Finds files in the project');
  });
});
