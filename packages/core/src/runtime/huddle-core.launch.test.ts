/**
 * HuddleCore + managed runs end to end (M4 WP6, F13 F16 F17 F20, ADR-020): templates are stored, a run is launched
 * with the fake claude (test/fake-claude-stream.mjs) as the driver's command, its hooks come back over real HTTP from
 * the fake (FAKE_HOOK_URL), worktrees are real git worktrees of a temp repository (hooks and global config off), and
 * every outcome is read from the events and the state. No real `claude`, no model, no cost.
 */
import { execFileSync, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HuddleEvent, type TeamTemplate } from '@huddle/shared';
import { budgetOverItemId } from '../detect/index.js';
import { consentRecord } from '../test/consent.js';
import { HuddleCore, LAUNCH_NEEDS_ATTACH_MESSAGE, type HuddleCoreDeps } from './huddle-core.js';
import { writeHuddleSettings } from './huddle-settings.js';
import {
  managedRunEnv,
  NESTED_SESSION_ENV_VARS,
  runFailedItemId,
  TEMPLATE_RULES_UNSUPPORTED,
  type RunLaunchOptions,
} from './runs.js';
import { CLAUDE_NOT_FOUND_MESSAGE, CLAUDE_SHIM_ONLY_MESSAGE } from './claude-path.js';
import { templatesPath } from './templates.js';
import { createGitRunner, WorktreeManager, type GitRunner } from './worktree.js';
import { JsonlEventStore } from '../store/jsonl-store.js';
import { ORPHAN_ENDED, ORPHAN_NOT_CHECKED, ORPHAN_STOPPED } from './orphans.js';
import { runRegistryPath } from './run-registry.js';

const TOKEN = 'test-token-0123456789';
const FAKE = fileURLToPath(new URL('../test/fake-claude-stream.mjs', import.meta.url));
const TIMEOUT = 60_000;
/** Processes start slowly on Windows: vi.waitFor's 1 s default is too short here. */
const waitFor = (check: () => void | Promise<void>, options: { timeout?: number; interval?: number } = {}) =>
  vi.waitFor(check, { timeout: 15_000, interval: 25, ...options });

function gitOnPath(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitOnPath();

/** The file name the core looks for on PATH. */
const CLAUDE_FILE = process.platform === 'win32' ? 'claude.exe' : 'claude';

/** `base` with its PATH (any case: `Path` on Windows) replaced by `dirs` followed by the old value. */
function withPath(base: NodeJS.ProcessEnv, dirs: string[], keepOld = true): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  let old = '';
  for (const [name, value] of Object.entries(base)) {
    if (name.toUpperCase() === 'PATH') old = value ?? '';
    else out[name] = value;
  }
  out.PATH = [...dirs, ...(keepOld && old !== '' ? [old] : [])].join(path.delimiter);
  return out;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Env {
  root: string;
  dataDir: string;
  claudeDir: string;
  settingsPath: string;
  forwarder: string;
  repo: string;
  plain: string;
  worktreeData: string;
  fakeLog: string;
  /** On the run's PATH, first: holds the stand-in claude the core resolves. */
  bin: string;
  git: GitRunner;
  spawned: { command: string; args: readonly string[]; options: SpawnOptions }[];
  launch: RunLaunchOptions;
}

async function makeEnv(): Promise<Env> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-launch-')));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = createGitRunner({
    configArgs: [
      '-c',
      `core.hooksPath=${path.join(root, 'no-such-hooks-dir')}`,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Huddle Test',
      '-c',
      'user.email=huddle-test@example.invalid',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'core.autocrlf=false',
    ],
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-gitconfig') },
  });
  const env: Env = {
    root,
    dataDir: path.join(root, 'data'),
    claudeDir: path.join(root, 'claude'),
    settingsPath: path.join(root, 'claude', 'settings.json'),
    forwarder: path.join(root, 'forwarder.mjs'),
    repo: path.join(root, 'repo'),
    plain: path.join(root, 'plain'),
    worktreeData: path.join(root, 'local'),
    fakeLog: path.join(root, 'fake.log'),
    bin: path.join(root, 'bin'),
    git,
    spawned: [],
    launch: {},
  };
  await fsp.mkdir(env.claudeDir, { recursive: true });
  await fsp.mkdir(env.plain, { recursive: true });
  await fsp.mkdir(path.join(env.repo, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(env.forwarder, '// test forwarder\n');
  await fsp.writeFile(env.settingsPath, '{}\n');
  await fsp.writeFile(
    path.join(env.repo, '.claude', 'agents', 'explore.md'),
    '---\nname: Explore\ndescription: Finds files in the project\n---\nBody\n',
  );
  await fsp.writeFile(path.join(env.repo, 'README.md'), 'hello\n');
  if (HAS_GIT) {
    for (const args of [['init'], ['add', '.'], ['commit', '-m', 'first']]) {
      const r = await git(['-C', env.repo, ...args]);
      if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    }
  }
  // The run's PATH starts with a folder holding a stand-in `claude` (never run: `spawn` below runs the fake), so the
  // core resolves claude to an absolute path without a real install (security review M2).
  await fsp.mkdir(env.bin, { recursive: true });
  await fsp.writeFile(path.join(env.bin, CLAUDE_FILE), 'stand-in\n', { mode: 0o755 });
  env.launch = {
    worktreeDataDir: env.worktreeData,
    git,
    stopGraceMs: 1500,
    env: {
      ...withPath(process.env, [env.bin]),
      FAKE_LOG: env.fakeLog,
      // Set by Claude Code in the processes it starts (this test may itself run inside one): must not reach the run.
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '12345',
      // The user's own settings: kept.
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    },
    spawn: (command, args, options) => {
      env.spawned.push({ command, args, options });
      return nodeSpawn(process.execPath, [FAKE, ...args], options);
    },
  };
  return env;
}

async function startCore(env: Env, extra: Partial<HuddleCoreDeps> = {}, attach = true) {
  if (attach) await writeHuddleSettings(env.dataDir, consentRecord(env.claudeDir, env.settingsPath));
  const core = new HuddleCore({
    dataDir: env.dataDir,
    claudeConfigDir: env.claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: env.forwarder,
    newToken: () => TOKEN,
    batchIntervalMs: 0,
    launch: env.launch,
    runShutdownGraceMs: 500,
    ...extra,
  });
  cleanups.push(() => core.dispose());
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  expect(started.setup.attached).toBe(attach);
  // The fake posts its hooks here, like the user-level http hooks would.
  env.launch.env = {
    ...env.launch.env,
    FAKE_HOOK_URL: `http://127.0.0.1:${String(started.port)}`,
    FAKE_HOOK_TOKEN: TOKEN,
  };
  return { core, port: started.port };
}

function template(env: Env, over: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'tpl-review',
    name: 'Review team',
    prompt: 'hello there',
    cwd: env.repo,
    mainAgent: null,
    model: null,
    permissionMode: 'default',
    agents: {
      lister: { description: 'Lists files', prompt: 'List files.', tools: ['Glob'] },
      reader: { description: 'Reads files', prompt: 'Read files.', tools: ['Read'] },
    },
    worktree: false,
    ...over,
  };
}

async function launch(core: HuddleCore, t: TeamTemplate, promptOverride?: string): Promise<string> {
  const result = await core.command({
    type: 'run.launch',
    template: t,
    ...(promptOverride !== undefined ? { promptOverride } : {}),
  });
  if (!result.ok) throw new Error(result.message);
  expect(result.detail).toMatch(/^[0-9a-f-]{36}$/);
  return result.detail ?? '';
}

function allEvents(core: HuddleCore, key: string): HuddleEvent[] {
  return core.getEvents(key, 500);
}

function ofType<T extends HuddleEvent['type']>(
  core: HuddleCore,
  key: string,
  type: T,
): Extract<HuddleEvent, { type: T }>[] {
  return allEvents(core, key).filter((e): e is Extract<HuddleEvent, { type: T }> => e.type === type);
}

interface FakeLog {
  stdin: string[];
  hooks: { hook: string; status?: number }[];
}

function readFakeLog(file: string): FakeLog {
  const out: FakeLog = { stdin: [], hooks: [] };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line) as {
      stdin?: { type: string; message?: { content: { text: string }[] } };
      hook?: string;
      status?: number;
    };
    if (entry.stdin?.type === 'user') out.stdin.push(entry.stdin.message?.content[0]?.text ?? '');
    if (entry.hook !== undefined)
      out.hooks.push({ hook: entry.hook, ...(entry.status !== undefined ? { status: entry.status } : {}) });
  }
  return out;
}

function postJson(port: number, route: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: route,
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

/** One OTLP logs batch with one `api_request` (shape from fixtures/single-agent.jsonl). */
function apiRequest(sessionId: string, requestId: string, cacheCreation: number): unknown {
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
                  i('cache_creation_tokens', cacheCreation),
                  { key: 'cost_usd', value: { doubleValue: 0.01 } },
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('managedRunEnv', () => {
  it('removes the variables Claude Code sets in its child processes, any case, and keeps everything else', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: 'p',
      CLAUDECODE: '1',
      claude_code_entrypoint: 'cli',
      CLAUDE_CODE_SSE_PORT: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      AI_AGENT: 'claude-code',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      CLAUDE_CONFIG_DIR: 'c',
      ANTHROPIC_API_KEY: 'k',
    };
    expect(managedRunEnv(base)).toEqual({
      PATH: 'p',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      CLAUDE_CONFIG_DIR: 'c',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(NESTED_SESSION_ENV_VARS).toEqual(
      expect.arrayContaining(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']),
    );
  });
});

describe('HuddleCore templates', () => {
  it('upsert, remove, state, a restart reads them back; launch by id', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    const first = await startCore(env);
    const t = template(env, { id: 'a' });
    expect(await first.core.command({ type: 'template.upsert', template: t })).toEqual({ ok: true });
    expect(await first.core.command({ type: 'template.upsert', template: { ...t, id: 'b', name: 'B' } })).toEqual({
      ok: true,
    });
    expect(await first.core.command({ type: 'template.upsert', template: { ...t, name: 'A2' } })).toEqual({ ok: true });
    expect(first.core.getState().templates?.map((x) => [x.id, x.name])).toEqual([
      ['a', 'A2'],
      ['b', 'B'],
    ]);
    expect(await first.core.command({ type: 'template.remove', templateId: 'b' })).toEqual({ ok: true });
    expect(await first.core.command({ type: 'template.remove', templateId: 'b' })).toMatchObject({ code: 'not_found' });
    expect(await first.core.command({ type: 'template.upsert', template: { ...t, id: 'bad', cwd: '' } })).toMatchObject(
      { ok: false, code: 'invalid' },
    );
    // The renderer gets a copy: changing it changes nothing in the core.
    const copy = first.core.getState().templates?.[0];
    if (copy) copy.name = 'mutated';
    expect(first.core.getState().templates?.[0]?.name).toBe('A2');
    await first.core.dispose();

    const second = await startCore(env);
    expect(second.core.getState().templates?.map((x) => x.id)).toEqual(['a']);
    expect(await second.core.command({ type: 'run.launch', templateId: 'nope' })).toMatchObject({ code: 'not_found' });
    const result = await second.core.command({ type: 'run.launch', templateId: 'a' });
    expect(result.ok).toBe(true);
    const runId = result.ok ? (result.detail ?? '') : '';
    expect(ofType(second.core, runId, 'run.launched')[0]).toMatchObject({ templateId: 'a', claudeSessionId: runId });
  });

  it(
    'a corrupt templates.json: empty list and a warning; the first save moves it aside',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      await fsp.mkdir(env.dataDir, { recursive: true });
      await fsp.writeFile(templatesPath(env.dataDir), '{"version":1,"templates":[{"id":');
      const warnings: string[] = [];
      const { core } = await startCore(env, {
        logger: { info: () => undefined, warn: (m) => warnings.push(m), error: () => undefined },
      });
      expect(core.getState().templates).toEqual([]);
      expect(warnings.some((w) => w.includes('templates.json is not valid JSON'))).toBe(true);
      expect(await core.command({ type: 'template.upsert', template: template(env) })).toEqual({ ok: true });
      const names = await fsp.readdir(env.dataDir);
      const aside = names.filter((n) => n.startsWith('templates.json.bad-'));
      expect(aside).toHaveLength(1);
      expect(await fsp.readFile(path.join(env.dataDir, aside[0] ?? ''), 'utf8')).toBe(
        '{"version":1,"templates":[{"id":',
      );
      expect(JSON.parse(await fsp.readFile(templatesPath(env.dataDir), 'utf8'))).toMatchObject({
        version: 1,
        templates: [{ id: 'tpl-review' }],
      });
    },
  );
});

describe('HuddleCore run.launch', () => {
  it(
    'refuses a template with rules of its own (fail closed), before any worktree or process',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const { core } = await startCore(env);
      const result = await core.command({
        type: 'run.launch',
        template: template(env, { worktree: true, ruleIds: ['my-deny'] }),
      });
      expect(result).toEqual({ ok: false, code: 'unsupported', message: TEMPLATE_RULES_UNSUPPORTED });
      expect(env.spawned).toEqual([]);
      expect(core.getState().rootKeys).toEqual([]);
      expect(existsSync(path.join(env.worktreeData, 'worktrees'))).toBe(false);
      // An empty list is no rules.
      expect(
        (await core.command({ type: 'run.launch', template: template(env, { cwd: env.plain, ruleIds: [] }) })).ok,
      ).toBe(true);
    },
  );

  it(
    'exit harness options: no attach needed, --settings <file> passed, the command overridden',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const settingsFile = path.join(env.root, 'harness-settings.json');
      await fsp.writeFile(settingsFile, '{}');
      env.launch = { ...env.launch, skipAttachCheck: true, settingsFile, claudeCommand: 'my-claude' };
      const { core } = await startCore(env, {}, false);
      const runId = await launch(core, template(env, { cwd: env.plain }));
      const [call] = env.spawned;
      expect(call?.command).toBe('my-claude');
      const args = call?.args ?? [];
      expect(args[args.indexOf('--settings') + 1]).toBe(settingsFile);
      expect(args[args.indexOf('--session-id') + 1]).toBe(runId);
      await waitFor(() => {
        expect(ofType(core, runId, 'run.result')).toHaveLength(1);
      });
    },
  );

  it('refuses without attached hooks: nothing spawned, no event', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    const { core } = await startCore(env, {}, false);
    expect(await core.command({ type: 'run.launch', template: template(env) })).toEqual({
      ok: false,
      code: 'unsupported',
      message: LAUNCH_NEEDS_ATTACH_MESSAGE,
    });
    expect(env.spawned).toEqual([]);
    expect(core.getState().rootKeys).toEqual([]);
  });

  it(
    'refuses a missing folder, an empty prompt and an unknown permission mode before anything is made',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const { core } = await startCore(env);
      const cases: [Partial<TeamTemplate>, string][] = [
        [{ cwd: path.join(env.root, 'missing') }, 'not_found'],
        [{ cwd: 'relative/folder' }, 'invalid'],
        [{ prompt: '   ' }, 'invalid'],
        [{ permissionMode: 'yolo' }, 'invalid'],
        [{ model: '--settings' }, 'invalid'],
      ];
      for (const [over, code] of cases) {
        expect(await core.command({ type: 'run.launch', template: template(env, over) })).toMatchObject({
          ok: false,
          code,
        });
      }
      expect(env.spawned).toEqual([]);
      expect(core.getState().rootKeys).toEqual([]);
    },
  );

  // The allow rules refuse 8.3 short names (RUNNER~1) and need the trusted folder and the agent's cwd in one spelling:
  // a folder chosen through another spelling (a junction here, a short TEMP on CI) runs in its long, real form.
  it(
    'runs in the canonical folder when the chosen folder is reached through a junction',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const link = path.join(path.dirname(env.plain), 'plain-link');
      await fsp.symlink(env.plain, link, 'junction');
      const { core } = await startCore(env);
      const runId = await launch(core, template(env, { cwd: link }));
      expect(env.spawned[0]?.options.cwd).toBe(env.plain);
      expect(ofType(core, runId, 'run.launched')[0]).toMatchObject({ cwd: env.plain, worktree: null });
      expect(core.getState().agents[runId]).toMatchObject({ origin: 'managed', sessionCwd: env.plain });
    },
  );

  it(
    'launches a team: argv, agents file, prompt on stdin, env cleaned, root managed, hooks under the same session',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const { core } = await startCore(env);
      const runId = await launch(core, template(env, { cwd: env.plain }), 'first prompt');
      const [call] = env.spawned;
      expect(env.spawned).toHaveLength(1);
      const args = call?.args ?? [];
      expect(args.slice(0, 6)).toEqual([
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ]);
      expect(args[args.indexOf('--session-id') + 1]).toBe(runId);
      const agentsFile = args[args.indexOf('--agents') + 1] ?? '';
      expect(path.dirname(agentsFile)).toBe(path.join(env.dataDir, 'run-agents'));
      expect(args.join(' ')).not.toContain('first prompt');
      expect(call?.options).toMatchObject({ cwd: env.plain, shell: false });
      // Without the harness-only options: the installed claude, and never --settings (ADR-020 §1).
      // Never the bare name (M2): the absolute path found on the run's PATH.
      expect(call?.command).toBe(path.join(env.bin, CLAUDE_FILE));
      expect(args).not.toContain('--settings');
      const childEnv = call?.options.env ?? {};
      expect(childEnv.CLAUDECODE).toBeUndefined();
      expect(childEnv.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(childEnv.CLAUDE_CODE_SSE_PORT).toBeUndefined();
      expect(childEnv.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');

      await waitFor(() => {
        expect(ofType(core, runId, 'run.result')).toHaveLength(1);
        expect(readFakeLog(env.fakeLog).hooks.map((h) => h.hook)).toContain('SessionStart');
      });
      expect(readFakeLog(env.fakeLog).stdin).toEqual(['first prompt']);
      const state = core.getState();
      expect(state.rootKeys).toEqual([runId]);
      const root = state.agents[runId];
      expect(root).toMatchObject({ origin: 'managed', kind: 'main', sessionCwd: env.plain, cwd: env.plain });
      expect(root?.capabilities.message).toBe('live');
      expect(root?.run).toMatchObject({ runId, agentNames: ['lister', 'reader'], worktree: null, templateId: null });
      // The fake's SessionStart hook (origin attached: a hook cannot tell) filed under the same session.
      expect(ofType(core, runId, 'session.started')).toHaveLength(1);
      const types = allEvents(core, runId).map((e) => e.type);
      expect(types.indexOf('run.launched')).toBeLessThan(types.indexOf('session.started'));
      expect(ofType(core, runId, 'control.applied').map((e) => [e.action, e.detail])).toEqual([['launch', runId]]);
      // Stream events: source stream; the rate limit is in state.
      expect(ofType(core, runId, 'limits.measured')[0]).toMatchObject({ source: 'stream' });
      expect(state.rateLimits?.sevenDayUsedPct).toBe(50);
    },
  );

  it(
    'a worktree run: created, root works there, token budget pause lapses into a stop, summary, discard',
    { timeout: TIMEOUT, skip: !HAS_GIT },
    async () => {
      const env = await makeEnv();
      env.launch.env = { ...env.launch.env, FAKE_TOUCH: 'made-by-run.txt' };
      // A pause reaches its hold limit 400 ms after the hold starts (the default is 595 s).
      const { core, port } = await startCore(env, {
        holdTimeoutsMs: { permissionRequest: 600_000, preToolUse: 5_400 },
      });
      const budget = { scope: 'session', maxTokens: 1000, warnAtFraction: 0.8, onExceed: 'pause' } as const;
      const runId = await launch(core, template(env, { worktree: true, budgets: [budget] }));

      const created = ofType(core, runId, 'worktree.created');
      expect(created).toHaveLength(1);
      const wtPath = created[0]?.path ?? '';
      expect(path.dirname(wtPath)).toBe(path.join(env.worktreeData, 'worktrees'));
      expect(created[0]).toMatchObject({ runId, branch: `huddle/${runId}` });
      const types = allEvents(core, runId).map((e) => e.type);
      expect(types.slice(0, 3)).toEqual(['worktree.created', 'run.launched', 'budget.set']);
      expect(env.spawned[0]?.options.cwd).toBe(wtPath);
      expect(ofType(core, runId, 'run.launched')[0]).toMatchObject({ cwd: wtPath, worktree: { path: wtPath } });
      expect(core.getState().budgets).toEqual([
        expect.objectContaining({ scope: 'session', targetKey: runId, budget: { ...budget, scope: 'session' } }),
      ]);
      await waitFor(() => {
        expect(ofType(core, runId, 'run.result')).toHaveLength(1);
      });
      expect(core.getState().agents[runId]).toMatchObject({ origin: 'managed', sessionCwd: wtPath, cwd: wtPath });
      // The project agents (checked out in the worktree) describe roles of this session only; no other root.
      await waitFor(() => {
        expect(ofType(core, runId, 'role.described').map((e) => e.role)).toEqual(['Explore']);
      });
      expect(core.getState().rootKeys).toEqual([runId]);

      // Over the token budget: the root is paused (source huddle).
      expect(await postJson(port, '/v1/logs', apiRequest(runId, 'req-1', 5000))).toBe(200);
      const over = budgetOverItemId(`session:${runId}`);
      await waitFor(() => {
        expect(core.getState().agents[runId]?.pausePending).toBe(true);
      });
      // The next tool call is held; at its hold limit the run is stopped (ADR-020 §4).
      expect(
        await core.command({ type: 'agent.message', agentKey: runId, text: 'slow 30000', delivery: 'auto' }),
      ).toEqual({ ok: true });
      await waitFor(
        () => {
          expect(ofType(core, runId, 'run.exited')).toHaveLength(1);
        },
        { timeout: 20_000 },
      );
      expect(ofType(core, runId, 'hold.ended')[0]).toMatchObject({ why: 'hold_limit' });
      expect(ofType(core, runId, 'run.exited')[0]).toMatchObject({ how: 'stopped' });
      const stops = ofType(core, runId, 'control.applied').filter((e) => e.action === 'stop');
      expect(stops).toEqual([expect.objectContaining({ source: 'huddle', detail: over })]);
      expect(core.getState().agents[runId]).toMatchObject({ status: 'stopped' });
      await waitFor(() => {
        expect(ofType(core, runId, 'worktree.summarized')).toHaveLength(1);
      });
      expect(ofType(core, runId, 'worktree.summarized')[0]).toMatchObject({
        untracked: 1,
        files: [{ path: 'made-by-run.txt', status: 'untracked' }],
      });

      // Open answers the folder; Stop and End are off now.
      expect(await core.command({ type: 'run.openWorktree', runId })).toEqual({ ok: true, detail: wtPath });
      expect(await core.command({ type: 'run.stop', runId })).toMatchObject({ ok: false, code: 'unsupported' });
      // Discard: folder and branch gone.
      expect(await core.command({ type: 'run.discardWorktree', runId })).toEqual({ ok: true });
      expect(ofType(core, runId, 'worktree.closed')).toEqual([
        expect.objectContaining({ outcome: 'discarded', error: null }),
      ]);
      expect(existsSync(wtPath)).toBe(false);
      const branch = await env.git(['-C', env.repo, 'show-ref', '--verify', '--quiet', `refs/heads/huddle/${runId}`]);
      expect(branch.code).not.toBe(0);
      expect(await core.command({ type: 'run.openWorktree', runId })).toMatchObject({ ok: false, code: 'unsupported' });
      expect(await core.command({ type: 'run.discardWorktree', runId })).toMatchObject({
        ok: false,
        code: 'unsupported',
      });
    },
  );

  it(
    'keep: refused while alive is only for discard; keep works on a live run and the branch stays',
    { timeout: TIMEOUT, skip: !HAS_GIT },
    async () => {
      const env = await makeEnv();
      const { core } = await startCore(env);
      const runId = await launch(core, template(env, { worktree: true }));
      await waitFor(() => {
        expect(ofType(core, runId, 'run.result')).toHaveLength(1);
      });
      expect(await core.command({ type: 'run.discardWorktree', runId })).toMatchObject({
        ok: false,
        code: 'unsupported',
      });
      expect(await core.command({ type: 'run.keepWorktree', runId })).toEqual({ ok: true });
      expect(ofType(core, runId, 'worktree.closed')).toEqual([expect.objectContaining({ outcome: 'kept' })]);
      const wtPath = core.getState().agents[runId]?.run?.worktree?.path ?? '';
      expect(existsSync(wtPath)).toBe(true);
      expect(await core.command({ type: 'run.end', runId })).toEqual({ ok: true });
      await waitFor(() => {
        expect(ofType(core, runId, 'run.exited')).toEqual([expect.objectContaining({ how: 'completed', exitCode: 0 })]);
      });
      expect(await core.command({ type: 'run.discardWorktree', runId })).toMatchObject({
        ok: false,
        code: 'unsupported',
      });
      const branch = await env.git(['-C', env.repo, 'show-ref', '--verify', '--quiet', `refs/heads/huddle/${runId}`]);
      expect(branch.code).toBe(0);
    },
  );

  it(
    'a folder that is not a repository: no worktree, nothing spawned, no run',
    { timeout: TIMEOUT, skip: !HAS_GIT },
    async () => {
      const env = await makeEnv();
      const { core } = await startCore(env);
      const result = await core.command({
        type: 'run.launch',
        template: template(env, { cwd: env.plain, worktree: true }),
      });
      expect(result).toMatchObject({ ok: false, code: 'failed' });
      expect(result.ok ? '' : result.message).toMatch(/^No worktree was made/);
      expect(env.spawned).toEqual([]);
      expect(core.getState().rootKeys).toEqual([]);
      expect(
        existsSync(path.join(env.worktreeData, 'worktrees'))
          ? await fsp.readdir(path.join(env.worktreeData, 'worktrees'))
          : [],
      ).toEqual([]);
    },
  );

  it(
    'a spawn failure: run.exited spawn_failed, an error item, and the worktree it made is removed',
    { timeout: TIMEOUT, skip: !HAS_GIT },
    async () => {
      const env = await makeEnv();
      env.launch.spawn = (command, args, options) => {
        env.spawned.push({ command, args, options });
        return nodeSpawn(path.join(env.root, 'no-such-claude.exe'), [...args], options);
      };
      const { core } = await startCore(env);
      const result = await core.command({ type: 'run.launch', template: template(env, { worktree: true }) });
      expect(result).toMatchObject({ ok: false, code: 'failed' });
      expect(env.spawned).toHaveLength(1);
      const runId = core.getState().rootKeys[0] ?? '';
      expect(ofType(core, runId, 'run.exited')).toEqual([
        expect.objectContaining({ how: 'spawn_failed', exitCode: null }),
      ]);
      expect(ofType(core, runId, 'run.exited')[0]?.error).toMatch(/ENOENT|could not start/);
      const item = core.getState().inbox.find((i) => i.id === runFailedItemId(runId));
      expect(item).toMatchObject({ kind: 'error', severity: 'action_required', agentKey: runId, resolvedAt: null });
      expect(core.getState().agents[runId]).toMatchObject({ status: 'failed' });
      const wtPath = ofType(core, runId, 'worktree.created')[0]?.path ?? '';
      expect(existsSync(wtPath)).toBe(false);
      expect(ofType(core, runId, 'worktree.closed')).toEqual([expect.objectContaining({ outcome: 'discarded' })]);
      // The agents file was removed with the failed start.
      expect(await fsp.readdir(path.join(env.dataDir, 'run-agents'))).toEqual([]);
    },
  );

  it(
    'spawns claude by its absolute PATH location, never a claude.exe committed in the folder it runs in (M2)',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      // A repository that commits its own claude: in the run's folder, and on a relative and an empty PATH entry.
      for (const name of ['claude.exe', 'claude.com', 'claude']) {
        await fsp.writeFile(path.join(env.plain, name), 'planted\n', { mode: 0o755 });
      }
      const rel = path.relative(process.cwd(), env.plain);
      env.launch.env = withPath(env.launch.env ?? {}, ['', '.', ...(path.isAbsolute(rel) ? [] : [rel]), env.bin]);
      const { core } = await startCore(env);
      const runId = await launch(core, template(env, { cwd: env.plain }));
      expect(env.spawned.map((s) => s.command)).toEqual([path.join(env.bin, CLAUDE_FILE)]);
      expect(env.spawned[0]?.options).toMatchObject({ cwd: env.plain, shell: false });
      await waitFor(() => {
        expect(ofType(core, runId, 'run.result')).toHaveLength(1);
      });

      // Resolved once and kept: a second launch uses the same path without searching PATH again.
      env.launch.env = withPath(env.launch.env ?? {}, [], false);
      await launch(core, template(env, { cwd: env.plain }));
      expect(env.spawned.map((s) => s.command)).toEqual([
        path.join(env.bin, CLAUDE_FILE),
        path.join(env.bin, CLAUDE_FILE),
      ]);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'claude only as an npm .cmd shim: spawn_failed with a clear message, nothing spawned, no worktree made',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const npm = path.join(env.root, 'npm');
      await fsp.mkdir(npm);
      for (const name of ['claude.cmd', 'claude.ps1', 'claude']) await fsp.writeFile(path.join(npm, name), 'shim\n');
      env.launch.env = withPath(env.launch.env ?? {}, [npm], false);
      const { core } = await startCore(env);
      const result = await core.command({ type: 'run.launch', template: template(env, { worktree: HAS_GIT }) });
      expect(result).toMatchObject({
        ok: false,
        code: 'failed',
        message: expect.stringMatching(/\.cmd shim/) as unknown,
      });
      expect(env.spawned).toEqual([]);
      const runId = core.getState().rootKeys[0] ?? '';
      expect(ofType(core, runId, 'run.exited')).toEqual([
        expect.objectContaining({ how: 'spawn_failed', exitCode: null, error: CLAUDE_SHIM_ONLY_MESSAGE }),
      ]);
      expect(core.getState().inbox.find((i) => i.id === runFailedItemId(runId))).toMatchObject({
        detail: CLAUDE_SHIM_ONLY_MESSAGE,
      });
      expect(ofType(core, runId, 'worktree.created')).toEqual([]);
      expect(existsSync(path.join(env.worktreeData, 'worktrees'))).toBe(false);
    },
  );

  it(
    'claude not on PATH: spawn_failed with a clear message; found later, the next launch works',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const empty = path.join(env.root, 'empty-bin');
      await fsp.mkdir(empty);
      env.launch.env = withPath(env.launch.env ?? {}, [empty], false);
      const { core } = await startCore(env);
      const result = await core.command({ type: 'run.launch', template: template(env, { cwd: env.plain }) });
      expect(result).toMatchObject({
        ok: false,
        code: 'failed',
        message: expect.stringContaining(CLAUDE_NOT_FOUND_MESSAGE) as unknown,
      });
      expect(env.spawned).toEqual([]);
      const runId = core.getState().rootKeys[0] ?? '';
      expect(ofType(core, runId, 'run.exited')).toEqual([
        expect.objectContaining({ how: 'spawn_failed', error: CLAUDE_NOT_FOUND_MESSAGE }),
      ]);
      // A failed search is not kept: once claude is installed, launching works without a restart.
      env.launch.env = withPath(env.launch.env, [env.bin], false);
      await launch(core, template(env, { cwd: env.plain }));
      expect(env.spawned.map((s) => s.command)).toEqual([path.join(env.bin, CLAUDE_FILE)]);
    },
  );

  it('the harness claudeCommand is spawned as given, with no PATH search', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    env.launch = {
      ...env.launch,
      claudeCommand: 'harness-claude',
      env: withPath(env.launch.env ?? {}, [], false),
    };
    const { core } = await startCore(env);
    await launch(core, template(env, { cwd: env.plain }));
    expect(env.spawned.map((s) => s.command)).toEqual(['harness-claude']);
  });

  it.skipIf(process.platform !== 'win32')(
    'refuses a UNC, device or NT-prefixed folder before any file system call (L3)',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const { core } = await startCore(env);
      const stat = vi.spyOn(fsp, 'stat');
      try {
        for (const cwd of [
          '\\\\evil-host\\share',
          '//evil-host/share',
          '\\\\?\\UNC\\evil-host\\share',
          '\\\\.\\pipe\\x',
          '\\??\\UNC\\evil-host\\share',
          '\\rooted',
          'C:relative',
        ]) {
          expect(await core.command({ type: 'run.launch', template: template(env, { cwd }) }), cwd).toMatchObject({
            ok: false,
            code: 'invalid',
          });
        }
        const touched = stat.mock.calls
          .map((c) => String(c[0]))
          .filter((p) => /evil-host|pipe|rooted|relative/.test(p));
        expect(touched).toEqual([]);
      } finally {
        stat.mockRestore();
      }
      expect(env.spawned).toEqual([]);
      expect(core.getState().rootKeys).toEqual([]);
    },
  );
});

describe('HuddleCore start sweeps --agents files a crash left behind (L4)', () => {
  it('removes every agents-*.json in run-agents at start and leaves anything else', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    const dir = path.join(env.dataDir, 'run-agents');
    await fsp.mkdir(path.join(dir, 'agents-folder.json'), { recursive: true });
    for (const name of ['agents-0b6f2a8e-0000-4000-8000-000000000001.json', 'agents-old.json', 'notes.txt']) {
      await fsp.writeFile(path.join(dir, name), '{"a":{"description":"d","prompt":"secret prompt"}}');
    }
    const { core } = await startCore(env);
    expect((await fsp.readdir(dir)).sort()).toEqual(['agents-folder.json', 'notes.txt']);
    // A run launched after the sweep still gets (and then loses) its own file.
    const runId = await launch(core, template(env, { cwd: env.plain }));
    await waitFor(() => {
      expect(ofType(core, runId, 'run.result')).toHaveLength(1);
    });
  });

  it('a missing run-agents folder is fine', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    await startCore(env);
    expect(existsSync(path.join(env.dataDir, 'run-agents'))).toBe(false);
  });
});

describe('HuddleCore start reconciles runs a crash left behind', () => {
  /** A stand-in for a run's `claude` that outlived its Huddle: the fake, ignoring stdin's end, with this session id. */
  function orphanProcess(sessionId: string): number {
    const child = nodeSpawn(
      process.execPath,
      [
        FAKE,
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--session-id',
        sessionId,
      ],
      { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: { ...process.env, FAKE_IGNORE_EOF: '1' } },
    );
    cleanups.push(() => {
      child.kill();
      return Promise.resolve();
    });
    return child.pid ?? -1;
  }

  let n = 0;
  function event(type: string, sessionId: string, fields: Record<string, unknown>): HuddleEvent {
    n += 1;
    return {
      id: `crash-${String(n)}`,
      type,
      ts: Date.now() - 60_000 + n,
      sessionId,
      agentKey: sessionId,
      source: 'huddle',
      ...fields,
    } as unknown as HuddleEvent;
  }

  function launchedEvent(runId: string, cwd: string, worktree: { path: string; branch: string } | null) {
    return event('run.launched', runId, {
      runId,
      claudeSessionId: runId,
      templateId: null,
      cwd,
      model: null,
      permissionMode: 'default',
      mainAgent: null,
      agentNames: [],
      worktree,
    });
  }

  it(
    'kills a live run verified by its --session-id, leaves a reused pid alone, ends all three, worktree discardable',
    { timeout: TIMEOUT, skip: !HAS_GIT },
    async () => {
      const env = await makeEnv();
      const orphan = randomUUID();
      const reused = randomUUID();
      const unrecorded = randomUUID();
      const orphanPid = orphanProcess(orphan);
      // Another process now holds the pid runs.json names for `reused`: same program, another session.
      const decoyPid = orphanProcess(randomUUID());
      await waitFor(() => {
        expect(pidAlive(orphanPid) && pidAlive(decoyPid)).toBe(true);
      });

      // What the crashed Huddle left: a worktree, the log without run.exited, a queued note, and runs.json.
      const wt = await new WorktreeManager({ dataDir: env.worktreeData, now: Date.now, git: env.git }).createWorktree({
        repoDir: env.repo,
        runId: orphan,
      });
      const store = new JsonlEventStore({ baseDir: path.join(env.dataDir, 'events') });
      await store.append([
        event('worktree.created', orphan, {
          runId: orphan,
          path: wt.path,
          branch: wt.branch,
          baseCommit: wt.baseCommit,
          repoRoot: wt.repoRoot,
        }),
        launchedEvent(orphan, wt.path, { path: wt.path, branch: wt.branch }),
        {
          ...event('message.queued', orphan, {
            messageId: 'm-left',
            text: 'left in the outbox',
            delivery: 'next_tool',
          }),
          source: 'user',
        },
        launchedEvent(reused, env.plain, null),
        launchedEvent(unrecorded, env.plain, null),
      ]);
      await store.close();
      await fsp.writeFile(
        runRegistryPath(env.dataDir),
        JSON.stringify({
          version: 1,
          runs: [
            { runId: orphan, pid: orphanPid, startedAt: 1, command: 'C:\\x\\claude.exe' },
            { runId: reused, pid: decoyPid, startedAt: 1, command: 'C:\\x\\claude.exe' },
          ],
        }),
      );

      const { core } = await startCore(env);
      // Done before start resolved: the orphan's tree is gone, the decoy was never touched.
      expect(pidAlive(orphanPid)).toBe(false);
      expect(pidAlive(decoyPid)).toBe(true);
      expect(ofType(core, orphan, 'run.exited')).toEqual([
        expect.objectContaining({ how: 'stopped', exitCode: null, error: ORPHAN_STOPPED }),
      ]);
      expect(ofType(core, reused, 'run.exited')).toEqual([expect.objectContaining({ error: ORPHAN_ENDED })]);
      expect(ofType(core, unrecorded, 'run.exited')).toEqual([expect.objectContaining({ error: ORPHAN_NOT_CHECKED })]);
      for (const id of [orphan, reused, unrecorded]) expect(core.getState().agents[id]?.status).toBe('stopped');
      expect(ofType(core, orphan, 'message.dropped')).toEqual([
        expect.objectContaining({ messageId: 'm-left', reason: 'agent_ended' }),
      ]);
      expect(JSON.parse(await fsp.readFile(runRegistryPath(env.dataDir), 'utf8'))).toMatchObject({ runs: [] });

      // The worktree is summarized, and discard works now that the run is known to have ended.
      await waitFor(() => {
        expect(ofType(core, orphan, 'worktree.summarized')).toHaveLength(1);
      });
      expect(await core.command({ type: 'run.discardWorktree', runId: orphan })).toEqual({ ok: true });
      expect(existsSync(wt.path)).toBe(false);

      // A second start finds nothing left to do.
      await core.dispose();
      const { core: again } = await startCore({ ...env, launch: { ...env.launch } });
      expect(ofType(again, orphan, 'run.exited')).toHaveLength(1);
      expect(ofType(again, unrecorded, 'run.exited')).toHaveLength(1);
      expect(pidAlive(decoyPid)).toBe(true);
    },
  );

  it('a launched run is in runs.json while it lives and leaves it at its exit', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    const { core } = await startCore(env);
    const runId = await launch(core, template(env, { cwd: env.plain, agents: {} }));
    const read = async () =>
      (
        JSON.parse(await fsp.readFile(runRegistryPath(env.dataDir), 'utf8')) as {
          runs: { runId: string; pid: number; command: string }[];
        }
      ).runs;
    const [entry] = await read();
    expect(entry).toMatchObject({ runId, command: path.join(env.bin, CLAUDE_FILE) });
    expect(entry?.pid).toBeGreaterThan(0);
    expect(await core.command({ type: 'run.end', runId })).toEqual({ ok: true });
    await waitFor(() => {
      expect(ofType(core, runId, 'run.exited')).toHaveLength(1);
    });
    await waitFor(async () => {
      expect(await read()).toEqual([]);
    });
  });

  it(
    'when the process list cannot be read, nothing is killed and the run says it could not be checked',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const runId = randomUUID();
      const pid = orphanProcess(runId);
      const store = new JsonlEventStore({ baseDir: path.join(env.dataDir, 'events') });
      await store.append([launchedEvent(runId, env.plain, null)]);
      await store.close();
      await fsp.writeFile(
        runRegistryPath(env.dataDir),
        JSON.stringify({ version: 1, runs: [{ runId, pid, startedAt: 1, command: 'c' }] }),
      );
      const killed: number[] = [];
      env.launch = { ...env.launch, processCommandLines: () => Promise.resolve(null), kill: (p) => killed.push(p) };
      const { core } = await startCore(env);
      expect(killed).toEqual([]);
      expect(pidAlive(pid)).toBe(true);
      expect(ofType(core, runId, 'run.exited')).toEqual([expect.objectContaining({ error: ORPHAN_NOT_CHECKED })]);
    },
  );

  it(
    'a verified process that survives the kill is not ended in the log; an error item says so',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const runId = randomUUID();
      const store = new JsonlEventStore({ baseDir: path.join(env.dataDir, 'events') });
      await store.append([launchedEvent(runId, env.plain, null)]);
      await store.close();
      await fsp.writeFile(
        runRegistryPath(env.dataDir),
        JSON.stringify({ version: 1, runs: [{ runId, pid: 4242, startedAt: 1, command: 'c' }] }),
      );
      const killed: number[] = [];
      const lines = new Map([[4242, `claude.exe -p --session-id ${runId}`]]);
      env.launch = {
        ...env.launch,
        processCommandLines: () => Promise.resolve(lines),
        kill: (p) => killed.push(p),
      };
      const { core } = await startCore(env);
      expect(killed).toEqual([4242]);
      expect(ofType(core, runId, 'run.exited')).toEqual([]);
      expect(core.getState().inbox.find((i) => i.id === `run:${runId}:orphan`)).toMatchObject({
        kind: 'error',
        resolvedAt: null,
      });
      // Kept for the next start.
      expect(JSON.parse(await fsp.readFile(runRegistryPath(env.dataDir), 'utf8'))).toMatchObject({
        runs: [expect.objectContaining({ runId, pid: 4242 })],
      });
    },
  );
});

describe('HuddleCore run commands and messages', () => {
  it(
    'run.stop on a working run: stopped, control.applied stop by the user; agent.stop on an attached root is refused',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const { core, port } = await startCore(env);
      const runId = await launch(core, template(env, { cwd: env.plain, agents: {} }), 'slow 30000');
      await waitFor(() => {
        expect(readFakeLog(env.fakeLog).hooks.map((h) => h.hook)).toContain('PreToolUse');
      });
      expect(await core.command({ type: 'run.stop', runId })).toEqual({ ok: true });
      expect(ofType(core, runId, 'run.exited')).toEqual([expect.objectContaining({ how: 'stopped' })]);
      expect(ofType(core, runId, 'control.applied').filter((e) => e.action === 'stop')).toEqual([
        expect.objectContaining({ source: 'user', detail: null }),
      ]);
      expect(core.getState().agents[runId]?.status).toBe('stopped');
      expect(await core.command({ type: 'run.stop', runId })).toMatchObject({ ok: false, code: 'unsupported' });
      expect(await core.command({ type: 'run.end', runId })).toMatchObject({ ok: false, code: 'unsupported' });

      // An attached session cannot be stopped from here.
      const attached = 'attached-1';
      expect(
        await postJson(port, '/huddle/hooks/SessionStart', {
          session_id: attached,
          transcript_path: 'C:/t.jsonl',
          cwd: env.plain,
          permission_mode: 'default',
          hook_event_name: 'SessionStart',
          source: 'startup',
        }),
      ).toBe(200);
      expect(await core.command({ type: 'agent.stop', agentKey: attached })).toMatchObject({
        ok: false,
        code: 'unsupported',
      });
      expect(await core.command({ type: 'all.stop' })).toMatchObject({ ok: false, code: 'unsupported' });
    },
  );

  it('agent.stop on a managed root stops its run', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    const { core } = await startCore(env);
    const runId = await launch(core, template(env, { cwd: env.plain, agents: {} }), 'slow 30000');
    await waitFor(() => {
      expect(readFakeLog(env.fakeLog).hooks.map((h) => h.hook)).toContain('PreToolUse');
    });
    expect(await core.command({ type: 'agent.stop', agentKey: runId })).toEqual({ ok: true });
    expect(ofType(core, runId, 'run.exited')).toEqual([expect.objectContaining({ how: 'stopped' })]);
  });

  it(
    'a message to an idle root goes to stdin; to a working root it waits in the outbox; undelivered at exit is dropped',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const { core } = await startCore(env);
      const runId = await launch(core, template(env, { cwd: env.plain, agents: {} }));
      await waitFor(() => {
        expect(ofType(core, runId, 'run.result')).toHaveLength(1);
      });
      // Idle: written to stdin at once.
      expect(
        await core.command({ type: 'agent.message', agentKey: runId, text: '  slow 30000  ', delivery: 'auto' }),
      ).toEqual({ ok: true });
      await waitFor(() => {
        expect(ofType(core, runId, 'message.delivered')).toHaveLength(1);
      });
      const [queued] = ofType(core, runId, 'message.queued');
      expect(queued).toMatchObject({ source: 'user', text: 'slow 30000' });
      expect(ofType(core, runId, 'message.delivered')[0]).toMatchObject({
        messageId: queued?.messageId,
        via: 'stream_input',
      });
      expect(readFakeLog(env.fakeLog).stdin).toEqual(['hello there', 'slow 30000']);
      await waitFor(() => {
        expect(readFakeLog(env.fakeLog).hooks.map((h) => h.hook)).toContain('PreToolUse');
      });

      // Working: the outbox (next tool call or turn end), nothing written to stdin.
      expect(
        await core.command({ type: 'agent.message', agentKey: runId, text: 'and then this', delivery: 'next_tool' }),
      ).toEqual({ ok: true });
      expect(core.getState().agents[runId]?.outbox).toEqual([
        expect.objectContaining({ text: 'and then this', delivery: 'next_tool' }),
      ]);
      expect(readFakeLog(env.fakeLog).stdin).toHaveLength(2);
      const waiting = core.getState().agents[runId]?.outbox?.[0]?.messageId;

      // The run ends with the message still queued: dropped, agent_ended.
      expect(await core.command({ type: 'run.stop', runId })).toEqual({ ok: true });
      await waitFor(() => {
        expect(ofType(core, runId, 'message.dropped')).toEqual([
          expect.objectContaining({ messageId: waiting, reason: 'agent_ended' }),
        ]);
      });
      expect(core.getState().agents[runId]?.outbox ?? []).toEqual([]);
    },
  );

  it(
    'notes still queued when the turn ends go to stdin, in order, once, as stream_input',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const { core } = await startCore(env);
      // The tool runs 1.5 s after its PreToolUse; no other tool call comes in this turn.
      const runId = await launch(core, template(env, { cwd: env.plain, agents: {} }), 'slow 1500');
      await waitFor(() => {
        expect(readFakeLog(env.fakeLog).hooks.map((h) => h.hook)).toContain('PreToolUse');
      });
      for (const [text, delivery] of [
        ['first note', 'next_tool'],
        ['second note', 'auto'],
        ['third note', 'next_tool'],
      ] as const) {
        expect(await core.command({ type: 'agent.message', agentKey: runId, text, delivery })).toEqual({ ok: true });
      }
      const queuedIds = ofType(core, runId, 'message.queued').map((e) => e.messageId);
      expect(queuedIds).toHaveLength(3);
      expect(readFakeLog(env.fakeLog).stdin).toEqual(['slow 1500']);

      // The turn ends: one stdin message with all three, in order; the next turn answers it.
      await waitFor(() => {
        expect(ofType(core, runId, 'run.result')).toHaveLength(2);
      });
      expect(readFakeLog(env.fakeLog).stdin).toEqual(['slow 1500', 'first note\n\nsecond note\n\nthird note']);
      const delivered = ofType(core, runId, 'message.delivered');
      expect(delivered.map((e) => [e.messageId, e.via])).toEqual(queuedIds.map((id) => [id, 'stream_input']));
      expect(core.getState().agents[runId]?.outbox ?? []).toEqual([]);

      // Nothing more is written or delivered once the run is idle again, and nothing is dropped at the end.
      await new Promise((r) => setTimeout(r, 200));
      expect(readFakeLog(env.fakeLog).stdin).toHaveLength(2);
      expect(await core.command({ type: 'run.end', runId })).toEqual({ ok: true });
      await waitFor(() => {
        expect(ofType(core, runId, 'run.exited')).toEqual([expect.objectContaining({ how: 'completed' })]);
      });
      expect(ofType(core, runId, 'message.delivered')).toHaveLength(3);
      expect(ofType(core, runId, 'message.dropped')).toEqual([]);
    },
  );

  it('run.end on an idle run: it exits by itself, completed', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    const { core } = await startCore(env);
    const runId = await launch(core, template(env, { cwd: env.plain, agents: {} }));
    await waitFor(() => {
      expect(ofType(core, runId, 'run.result')).toHaveLength(1);
    });
    expect(await core.command({ type: 'run.end', runId })).toEqual({ ok: true });
    await waitFor(() => {
      expect(ofType(core, runId, 'run.exited')).toEqual([expect.objectContaining({ how: 'completed', exitCode: 0 })]);
    });
    expect(core.getState().agents[runId]?.status).toBe('done');
    expect(ofType(core, runId, 'control.applied').map((e) => e.action)).toEqual(['launch']);
  });
});

describe('HuddleCore agent definitions and placeholder sessions', () => {
  it(
    'no root is made from agent definitions for a session with no root yet; they are read once it has one',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const { core, port } = await startCore(env, { cwd: env.repo });
      // Telemetry for a session no hook has reported yet: its usage waits, and no role.described makes a root for it.
      expect(await postJson(port, '/v1/logs', apiRequest('ghost-session', 'req-g', 10))).toBe(200);
      await new Promise((r) => setTimeout(r, 200));
      expect(core.getState().rootKeys).toEqual([]);
      expect(ofType(core, 'ghost-session', 'role.described')).toEqual([]);
      // Its SessionStart makes the root; then the definitions are read for it.
      expect(
        await postJson(port, '/huddle/hooks/SessionStart', {
          session_id: 'ghost-session',
          transcript_path: 'C:/t.jsonl',
          cwd: env.repo,
          permission_mode: 'default',
          hook_event_name: 'SessionStart',
          source: 'startup',
        }),
      ).toBe(200);
      await waitFor(() => {
        expect(ofType(core, 'ghost-session', 'role.described').map((e) => e.role)).toEqual(['Explore']);
      });
      expect(core.getState().rootKeys).toEqual(['ghost-session']);
    },
  );
});

describe('HuddleCore quit with managed runs', () => {
  it(
    'ends every run: an idle one exits cleanly, a working one that ignores stdin is killed; both are logged',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const { core } = await startCore(env);
      const idle = await launch(core, template(env, { cwd: env.plain, agents: {} }));
      env.launch.env = { ...env.launch.env, FAKE_IGNORE_EOF: '1' };
      const stuck = await launch(core, template(env, { cwd: env.plain, agents: {} }), 'slow 60000');
      await waitFor(() => {
        expect(ofType(core, idle, 'run.result')).toHaveLength(1);
        expect(readFakeLog(env.fakeLog).hooks.map((h) => h.hook)).toContain('PreToolUse');
      });
      const pids = env.spawned.map((s) => s.options).length;
      expect(pids).toBe(2);
      const children = core.getState();
      expect(children.rootKeys).toHaveLength(2);
      const before = Date.now();
      await core.dispose();
      expect(Date.now() - before).toBeLessThan(3500);

      // Read the log back with a fresh core: both runs ended.
      const env2 = { ...env, launch: { ...env.launch } };
      const { core: again } = await startCore(env2);
      expect(ofType(again, idle, 'run.exited')).toEqual([expect.objectContaining({ how: 'completed' })]);
      expect(ofType(again, stuck, 'run.exited')).toEqual([expect.objectContaining({ how: 'stopped' })]);
    },
  );

  it('the child process is gone after quit', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    let pid = -1;
    const spawnFake = env.launch.spawn;
    env.launch.spawn = (command, args, options) => {
      if (spawnFake === undefined) throw new Error('no spawn');
      const child = spawnFake(command, args, options);
      pid = child.pid ?? -1;
      return child;
    };
    env.launch.env = { ...env.launch.env, FAKE_IGNORE_EOF: '1' };
    const { core } = await startCore(env);
    await launch(core, template(env, { cwd: env.plain, agents: {} }), 'slow 60000');
    await waitFor(() => {
      expect(readFakeLog(env.fakeLog).hooks.map((h) => h.hook)).toContain('PreToolUse');
    });
    expect(pidAlive(pid)).toBe(true);
    await core.dispose();
    await waitFor(() => {
      expect(pidAlive(pid)).toBe(false);
    });
  });
});

/** Every file under `dir` (relative path -> sha256), for "nothing under the Claude config folder changed". */
async function treeHash(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out[path.relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  await walk(dir);
  return out;
}

const MCP_SOURCE = fileURLToPath(new URL('../../../../scripts/huddle-mcp.mjs', import.meta.url));

interface SpawnSnapshot {
  args: readonly string[];
  files: Record<string, string>;
}

/** Wraps the fake's spawn: at spawn time (the files exist then), reads every file the argv names. */
function snapshotSpawns(env: Env): SpawnSnapshot[] {
  const snaps: SpawnSnapshot[] = [];
  const inner = env.launch.spawn;
  env.launch.spawn = (command, args, options) => {
    if (inner === undefined) throw new Error('no spawn');
    const files: Record<string, string> = {};
    for (const flag of ['--mcp-config', '--settings', '--agents']) {
      const i = args.indexOf(flag);
      const file = i >= 0 ? args[i + 1] : undefined;
      if (file !== undefined && existsSync(file)) files[flag] = readFileSync(file, 'utf8');
    }
    snaps.push({ args, files });
    return inner(command, args, options);
  };
  return snaps;
}

describe('self-reported progress in managed runs (M6 P4, F27, ADR-025)', () => {
  it(
    'gets --mcp-config and a --settings allow entry from its own folder, the prompt line and the tool for agents with a tools list; the folder goes at exit; ~/.claude untouched',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const snaps = snapshotSpawns(env);
      const { core } = await startCore(env, { mcpServerSource: MCP_SOURCE });
      // After attach (the hooks are written then): from here on, a run writes nothing under the Claude config folder.
      const before = await treeHash(env.claudeDir);
      const agents = {
        lister: { description: 'Lists files', prompt: 'List files.', tools: ['Glob'] },
        open: { description: 'Any tool', prompt: 'Anything.' },
      };
      const runId = await launch(core, template(env, { cwd: env.plain, agents }), 'first prompt');
      const snap = snaps[0];
      const args = snap?.args ?? [];
      const dir = path.join(env.dataDir, 'run-mcp', runId);
      expect(args[args.indexOf('--mcp-config') + 1]).toBe(path.join(dir, 'mcp.json'));
      expect(args[args.indexOf('--settings') + 1]).toBe(path.join(dir, 'settings.json'));
      // Not strict: the user's own MCP servers still load for the run.
      expect(args).not.toContain('--strict-mcp-config');
      // --mcp-config takes several values, so nothing may follow its one value.
      expect(args.indexOf('--mcp-config')).toBe(args.length - 2);

      const mcp = JSON.parse(snap?.files['--mcp-config'] ?? '{}') as {
        mcpServers: { huddle: { type: string; command: string; args: string[] } };
      };
      const script = path.join(dir, 'huddle-mcp.mjs').replace(/\\/g, '/');
      expect(mcp.mcpServers.huddle.type).toBe('stdio');
      expect(path.isAbsolute(mcp.mcpServers.huddle.command)).toBe(true);
      expect(mcp.mcpServers.huddle.args).toEqual([script]);
      expect(JSON.parse(snap?.files['--settings'] ?? '{}')).toEqual({
        permissions: { allow: ['mcp__huddle__report_progress', 'mcp__huddle__report_teammate'] },
      });
      const agentsJson = JSON.parse(snap?.files['--agents'] ?? '{}') as Record<string, { tools?: string[] }>;
      expect(agentsJson.lister?.tools).toEqual(['Glob', 'mcp__huddle__report_progress']);
      expect(agentsJson.open?.tools).toBeUndefined();

      await waitFor(() => {
        expect(ofType(core, runId, 'run.result')).toHaveLength(1);
      });
      const stdin = readFakeLog(env.fakeLog).stdin;
      expect(stdin[0]).toMatch(/^first prompt\n\nReport your progress with the report_progress tool/);
      // The stored template is unchanged (the tool and the line are added per run only).
      expect(core.getState().agents[runId]?.run?.agentNames).toEqual(['lister', 'open']);

      await core.command({ type: 'run.end', runId });
      await waitFor(() => {
        expect(ofType(core, runId, 'run.exited')).toHaveLength(1);
        expect(existsSync(dir)).toBe(false);
      });
      expect(await treeHash(env.claudeDir)).toEqual(before);
    },
  );

  it('the folder is owner-only', { timeout: TIMEOUT, skip: process.platform === 'win32' }, async () => {
    const env = await makeEnv();
    env.launch.env = { ...env.launch.env, FAKE_IGNORE_EOF: '1' };
    const { core } = await startCore(env, { mcpServerSource: MCP_SOURCE });
    const runId = await launch(core, template(env, { cwd: env.plain, agents: {} }), 'slow 60000');
    const dir = path.join(env.dataDir, 'run-mcp', runId);
    expect((await fsp.stat(dir)).mode & 0o777).toBe(0o700);
    for (const name of ['mcp.json', 'settings.json', 'huddle-mcp.mjs']) {
      expect((await fsp.stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
    }
    await core.dispose();
  });

  it(
    'off for a template with selfReport false, and for every run once the setting is off',
    { timeout: TIMEOUT },
    async () => {
      const env = await makeEnv();
      const snaps = snapshotSpawns(env);
      const { core } = await startCore(env, { mcpServerSource: MCP_SOURCE });
      const first = await launch(core, template(env, { cwd: env.plain, selfReport: false }), 'one');
      expect(await core.command({ type: 'settings.update', patch: { selfReport: { enabled: false } } })).toEqual({
        ok: true,
      });
      expect(core.getUserSettings().selfReport).toEqual({ enabled: false });
      const second = await launch(core, template(env, { cwd: env.plain }), 'two');
      for (const snap of snaps) {
        expect(snap.args).not.toContain('--mcp-config');
        expect(snap.args).not.toContain('--settings');
      }
      await waitFor(() => {
        expect(ofType(core, first, 'run.result')).toHaveLength(1);
        expect(ofType(core, second, 'run.result')).toHaveLength(1);
      });
      expect(readFakeLog(env.fakeLog).stdin).toEqual(['one', 'two']);
      expect(existsSync(path.join(env.dataDir, 'run-mcp'))).toBe(false);
    },
  );

  it('a missing server script: the run starts without self-report (fail open)', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    const snaps = snapshotSpawns(env);
    const { core } = await startCore(env, { mcpServerSource: path.join(env.root, 'missing', 'huddle-mcp.mjs') });
    const runId = await launch(core, template(env, { cwd: env.plain }), 'plain');
    expect(snaps[0]?.args).not.toContain('--mcp-config');
    await waitFor(() => {
      expect(ofType(core, runId, 'run.result')).toHaveLength(1);
    });
    expect(readFakeLog(env.fakeLog).stdin).toEqual(['plain']);
    expect(existsSync(path.join(env.dataDir, 'run-mcp', runId))).toBe(false);
  });

  it('the harness --settings file is merged into the per-run one, not replaced', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    const harness = path.join(env.root, 'harness-settings.json');
    await fsp.writeFile(harness, JSON.stringify({ hooks: { Stop: [] }, permissions: { deny: ['Bash(rm:*)'] } }));
    env.launch.settingsFile = harness;
    const snaps = snapshotSpawns(env);
    const { core } = await startCore(env, { mcpServerSource: MCP_SOURCE });
    const runId = await launch(core, template(env, { cwd: env.plain }), 'merged');
    const args = snaps[0]?.args ?? [];
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    expect(JSON.parse(snaps[0]?.files['--settings'] ?? '{}')).toEqual({
      hooks: { Stop: [] },
      permissions: { deny: ['Bash(rm:*)'], allow: ['mcp__huddle__report_progress', 'mcp__huddle__report_teammate'] },
    });
    await waitFor(() => {
      expect(ofType(core, runId, 'run.result')).toHaveLength(1);
    });
  });

  it('folders of runs that are not live are swept at start; other entries stay', { timeout: TIMEOUT }, async () => {
    const env = await makeEnv();
    const root = path.join(env.dataDir, 'run-mcp');
    const stale = path.join(root, '0b6f2a8e-0000-4000-8000-000000000001');
    await fsp.mkdir(stale, { recursive: true });
    await fsp.writeFile(path.join(stale, 'mcp.json'), '{}');
    await fsp.mkdir(path.join(root, 'not-a-run'), { recursive: true });
    await startCore(env, { mcpServerSource: MCP_SOURCE });
    expect(await fsp.readdir(root)).toEqual(['not-a-run']);
  });
});
