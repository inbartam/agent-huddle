/**
 * The opt-in self-report registration for attached sessions (M6 P4, F27, ADR-025), against a temp CLAUDE_CONFIG_DIR and
 * the fake claude (test/fake-claude-mcp.mjs, which refuses anything outside the OS temp folder). The real
 * `~/.claude.json` is hashed before and after. One test runs the real `claude` (temp CLAUDE_CONFIG_DIR only) and is
 * skipped unless HUDDLE_REAL_CLAUDE_MCP_TEST=1.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveClaudeExecutable } from '../runtime/claude-path.js';
import { claudeJsonLocation, displayCommand, McpRegistrar, type ClaudeRunner } from './mcp-register.js';

const FAKE = fileURLToPath(new URL('../test/fake-claude-mcp.mjs', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../../../scripts/huddle-mcp.mjs', import.meta.url));
const NODE = process.execPath;
const CLAUDE = path.join(os.tmpdir(), 'not-run', process.platform === 'win32' ? 'claude.exe' : 'claude');

/**
 * The real `~/.claude.json` is rewritten by every running Claude Code session, so a hash of the whole file fails at
 * random; the part this code could change is `mcpServers` (S19 g compared that key too).
 */
function hashOf(file: string): string {
  if (!existsSync(file)) return 'absent';
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const servers =
      typeof parsed === 'object' && parsed !== null ? ((parsed as { mcpServers?: unknown }).mcpServers ?? null) : null;
    return createHash('sha256').update(JSON.stringify(servers)).digest('hex');
  } catch {
    return 'unreadable';
  }
}
const realClaudeJson = path.join(os.homedir(), '.claude.json');
let realBefore = '';
beforeAll(() => {
  realBefore = hashOf(realClaudeJson);
});
afterAll(() => {
  expect(hashOf(realClaudeJson)).toBe(realBefore);
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Env {
  root: string;
  configDir: string;
  claudeJson: string;
  log: string;
  calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[];
  runClaude: ClaudeRunner;
  extraEnv: NodeJS.ProcessEnv;
}

async function makeEnv(): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-mcp-reg-'));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'claude-config');
  await fsp.mkdir(configDir, { recursive: true });
  const env: Env = {
    root,
    configDir,
    claudeJson: path.join(configDir, '.claude.json'),
    log: path.join(root, 'fake.log'),
    calls: [],
    extraEnv: {},
    runClaude: (command, args, options) => {
      env.calls.push({ command, args, env: options.env });
      return new Promise((resolve) => {
        execFile(
          NODE,
          [FAKE, ...args],
          { env: { ...options.env, FAKE_MCP_LOG: env.log, ...env.extraEnv }, cwd: options.cwd, windowsHide: true },
          (error, stdout, stderr) => {
            resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr });
          },
        );
      });
    },
  };
  return env;
}

function registrar(env: Env, over: { serverSource?: string } = {}): McpRegistrar {
  return new McpRegistrar({
    configDir: env.configDir,
    homeDir: path.join(env.root, 'home'),
    env: { ...process.env, CLAUDE_CONFIG_DIR: env.configDir },
    serverSource: over.serverSource ?? SOURCE,
    runClaude: env.runClaude,
    claudeCommand: CLAUDE,
    nodeCommand: NODE,
  });
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;

describe('claudeJsonLocation', () => {
  const home = path.resolve('/home/u');
  it('CLAUDE_CONFIG_DIR set: the file under it, env kept', () => {
    const dir = path.resolve('/cfg');
    const out = claudeJsonLocation(dir, home, { CLAUDE_CONFIG_DIR: dir, X: '1' });
    expect(out.file).toBe(path.join(dir, '.claude.json'));
    expect(out.childEnv).toEqual({ CLAUDE_CONFIG_DIR: dir, X: '1' });
  });
  it('not set and the default folder: ~/.claude.json, and the variable is NOT set for the child', () => {
    const out = claudeJsonLocation(path.join(home, '.claude'), home, { X: '1' });
    expect(out.file).toBe(path.join(home, '.claude.json'));
    expect(out.childEnv).toEqual({ X: '1' });
  });
  it('any other folder: the variable is set to it for the child', () => {
    const dir = path.resolve('/tmp/x');
    const out = claudeJsonLocation(dir, home, { CLAUDE_CONFIG_DIR: '', X: '1' });
    expect(out.file).toBe(path.join(dir, '.claude.json'));
    expect(out.childEnv).toEqual({ X: '1', CLAUDE_CONFIG_DIR: dir });
  });
});

describe('displayCommand', () => {
  it('quotes what has spaces and leaves the rest', () => {
    expect(displayCommand('C:\\Program Files\\claude.exe', ['mcp', 'add', '--', 'C:/a b/x.mjs'])).toBe(
      '"C:\\Program Files\\claude.exe" mcp add -- "C:/a b/x.mjs"',
    );
  });
});

describe('McpRegistrar (fake claude, temp CLAUDE_CONFIG_DIR)', () => {
  it('previews register: the exact argv, the one key that changes, nothing written', async () => {
    const env = await makeEnv();
    await fsp.writeFile(env.claudeJson, JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }));
    const before = await fsp.readFile(env.claudeJson, 'utf8');
    const r = registrar(env);
    const plan = await r.prepare('register');
    const script = r.serverTarget.replace(/\\/g, '/');
    expect(plan.args).toEqual(['mcp', 'add', '--scope', 'user', 'huddle', '--', NODE, script]);
    expect(plan.claudeCommand).toBe(CLAUDE);
    expect(plan.preview).toMatchObject({
      mode: 'register',
      state: 'absent',
      changed: true,
      refusal: null,
      claudeJsonPath: env.claudeJson,
      serverScriptPath: path.join(env.configDir, 'agent-huddle', 'huddle-mcp.mjs'),
    });
    expect(plan.preview.commands).toEqual([displayCommand(CLAUDE, plan.args ?? [])]);
    expect(plan.preview.diffText).toContain('"huddle"');
    expect(plan.preview.diff.filter((l) => l.op === '-' && l.text.includes('huddle'))).toEqual([]);
    expect(plan.preview.diff.some((l) => l.op === '+' && l.text.includes('huddle-mcp.mjs'))).toBe(true);
    expect(plan.preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // ADR-027: the server has two tools, and the notes name both (and both permission names).
    const notes = plan.preview.notes.join('\n');
    expect(notes).toContain('report_progress and report_teammate tools');
    expect(notes).toContain('mcp__huddle__report_progress');
    expect(notes).toContain('mcp__huddle__report_teammate');
    // Dry: nothing ran, nothing changed, no copy.
    expect(env.calls).toEqual([]);
    expect(await fsp.readFile(env.claudeJson, 'utf8')).toBe(before);
    expect(existsSync(r.serverTarget)).toBe(false);
  });

  it('nothing runs without consent or with another fingerprint', async () => {
    const env = await makeEnv();
    const r = registrar(env);
    const { preview } = await r.prepare('register');
    expect(await r.apply(preview, { consent: 'yes' })).toEqual({ status: 'needs-consent' });
    expect((await r.apply({ ...preview, fingerprint: 'f'.repeat(64) }, { consent: true })).status).toBe('stale');
    expect(env.calls).toEqual([]);
    expect(existsSync(env.claudeJson)).toBe(false);
  });

  it('register then unregister: a round trip leaves .claude.json deep-equal, the copy is gone', async () => {
    const env = await makeEnv();
    const original = { numStartups: 3, projects: { a: { allowedTools: [] } }, mcpServers: { other: { command: 'x' } } };
    await fsp.writeFile(env.claudeJson, JSON.stringify(original));
    const r = registrar(env);

    const add = await r.prepare('register');
    expect((await r.apply(add.preview, { consent: true })).status).toBe('written');
    expect(await r.isRegistered()).toBe(true);
    expect(existsSync(r.serverTarget)).toBe(true);
    expect(await fsp.readFile(r.serverTarget)).toEqual(await fsp.readFile(SOURCE));
    const added = (await readJson(env.claudeJson)) as { mcpServers: Record<string, unknown> };
    expect(added.mcpServers.huddle).toMatchObject({ command: NODE, args: [r.serverTarget.replace(/\\/g, '/')] });
    // The child got the temp config folder, never the real one.
    expect(env.calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(env.configDir);

    // Again: already ours, nothing to do.
    const again = await r.prepare('register');
    expect(again.preview).toMatchObject({ state: 'ours', changed: false, commands: [] });
    expect((await r.apply(again.preview, { consent: true })).status).toBe('unchanged');

    const remove = await r.prepare('unregister');
    expect(remove.args).toEqual(['mcp', 'remove', '--scope', 'user', 'huddle']);
    expect(remove.preview.diff.some((l) => l.op === '-' && l.text.includes('huddle-mcp.mjs'))).toBe(true);
    expect((await r.apply(remove.preview, { consent: true })).status).toBe('written');
    expect(await readJson(env.claudeJson)).toEqual(original);
    expect(existsSync(r.serverTarget)).toBe(false);
    expect(env.calls.map((c) => c.args[1])).toEqual(['add', 'remove']);
  });

  it("refuses a huddle server that is not the Huddle's: never replaced, never removed", async () => {
    const env = await makeEnv();
    const theirs = { mcpServers: { huddle: { type: 'stdio', command: 'python', args: ['their-huddle.py'] } } };
    await fsp.writeFile(env.claudeJson, JSON.stringify(theirs));
    const r = registrar(env);
    const add = await r.prepare('register');
    expect(add.preview).toMatchObject({ state: 'foreign', changed: false, commands: [] });
    expect(add.preview.refusal).toContain('will not replace it');
    expect((await r.apply(add.preview, { consent: true })).status).toBe('refused');
    const remove = await r.prepare('unregister');
    expect(remove.preview.state).toBe('foreign');
    expect((await r.apply(remove.preview, { consent: true })).status).toBe('refused');
    expect((await r.removeIfOurs()).status).toBe('unchanged');
    expect(env.calls).toEqual([]);
    expect(await readJson(env.claudeJson)).toEqual(theirs);
  });

  it('an unreadable .claude.json: refused, nothing runs', async () => {
    const env = await makeEnv();
    await fsp.writeFile(env.claudeJson, '{ not json');
    const r = registrar(env);
    const plan = await r.prepare('register');
    expect(plan.preview.state).toBe('unreadable');
    expect(plan.preview.refusal).toContain('not valid JSON');
    expect((await r.apply(plan.preview, { consent: true })).status).toBe('refused');
    expect(env.calls).toEqual([]);
  });

  it('a missing server script is a refusal, not a broken registration', async () => {
    const env = await makeEnv();
    const r = registrar(env, { serverSource: path.join(env.root, 'missing.mjs') });
    const plan = await r.prepare('register');
    expect(plan.preview.refusal).toContain('missing');
    expect(plan.preview.changed).toBe(false);
  });

  it('claude fails: an error, and no copy is left behind', async () => {
    const env = await makeEnv();
    env.extraEnv = { FAKE_MCP_FAIL: '1' };
    const r = registrar(env);
    const plan = await r.prepare('register');
    const result = await r.apply(plan.preview, { consent: true });
    expect(result.status).toBe('error');
    expect(result.status === 'error' ? result.error : '').toContain('claude mcp add exited with 1');
    expect(existsSync(r.serverTarget)).toBe(false);
    expect(existsSync(env.claudeJson)).toBe(false);
  });

  it("removeIfOurs: removes only the Huddle's server", async () => {
    const env = await makeEnv();
    const r = registrar(env);
    expect((await r.removeIfOurs()).status).toBe('unchanged');
    const add = await r.prepare('register');
    await r.apply(add.preview, { consent: true });
    expect((await r.removeIfOurs()).status).toBe('written');
    expect(await r.isRegistered()).toBe(false);
  });
});

/**
 * Real `claude`, temp CLAUDE_CONFIG_DIR only (S19 g showed it writes there). Opt-in: HUDDLE_REAL_CLAUDE_MCP_TEST=1.
 * The real `~/.claude.json` hash is checked by afterAll above.
 */
describe.skipIf(process.env.HUDDLE_REAL_CLAUDE_MCP_TEST !== '1')('McpRegistrar (real claude, gated)', () => {
  it('round trip under a temp CLAUDE_CONFIG_DIR', { timeout: 120_000 }, async () => {
    const env = await makeEnv();
    const runEnv = { ...process.env, CLAUDE_CONFIG_DIR: env.configDir };
    const claude = await resolveClaudeExecutable({ env: runEnv });
    if (!claude.ok) throw new Error(claude.message);
    const r = new McpRegistrar({
      configDir: env.configDir,
      homeDir: path.join(env.root, 'home'),
      env: runEnv,
      serverSource: SOURCE,
      nodeCommand: NODE,
    });
    const add = await r.prepare('register');
    expect(add.preview.changed).toBe(true);
    expect((await r.apply(add.preview, { consent: true })).status).toBe('written');
    const remove = await r.prepare('unregister');
    expect((await r.apply(remove.preview, { consent: true })).status).toBe('written');
    expect(await r.isRegistered()).toBe(false);
  });
});
