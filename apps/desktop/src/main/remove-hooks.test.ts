/**
 * The packaged `--remove-hooks` full clean-up (M6 P6, owner decision 2026-11-16): settings.json through a real
 * HookInstaller, the remembered consent through the core's `forgetConsent`, and the self-report MCP registration
 * through a real McpRegistrar driving the fake claude (packages/core/src/test/fake-claude-mcp.mjs, which refuses any
 * CLAUDE_CONFIG_DIR outside the OS temp folder). Every folder is a temp folder. The real `~/.claude.json` is never
 * touched: its `mcpServers` key (not the whole file, which Claude Code rewrites during normal use) is compared before
 * and after.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  forgetConsent,
  HookInstaller,
  McpRegistrar,
  readHuddleSettings,
  writeHuddleSettings,
  type McpRegistrarDeps,
} from '@huddle/core';
import { FORWARDER_FILE, MCP_SERVER_FILE, STATUSLINE_FILE } from './core-config.js';
import { FULL_REMOVAL, REMOVE_HOOKS_WORDS, removeHooks, type RemoveHooksDeps } from './remove-hooks.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const REPO_SCRIPTS = path.join(REPO, 'scripts');
const FAKE_CLAUDE = path.join(REPO, 'packages', 'core', 'src', 'test', 'fake-claude-mcp.mjs');
const NODE = process.execPath;
const CLAUDE = path.join(os.tmpdir(), 'not-run', process.platform === 'win32' ? 'claude.exe' : 'claude');

function mcpServersHash(file: string): string {
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
  realBefore = mcpServersHash(realClaudeJson);
});
afterAll(() => {
  expect(mcpServersHash(realClaudeJson)).toBe(realBefore);
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

const runFakeClaude: NonNullable<McpRegistrarDeps['runClaude']> = (_command, args, options) =>
  new Promise((resolve) => {
    execFile(NODE, [FAKE_CLAUDE, ...args], { env: options.env, cwd: options.cwd, windowsHide: true }, (e, out, err) => {
      resolve({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : null, stdout: out, stderr: err });
    });
  });

async function setup(settings: unknown) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-remove-'));
  dirs.push(root);
  const configDir = path.join(root, 'claude-config');
  const dataDir = path.join(root, 'app-data');
  await fsp.mkdir(configDir, { recursive: true });
  const settingsPath = path.join(configDir, 'settings.json');
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const installer = new HookInstaller({
    configDir,
    now: () => new Date('2026-11-16T10:00:00Z'),
    newToken: () => 'x'.repeat(43),
    forwarderSource: path.join(REPO_SCRIPTS, FORWARDER_FILE),
    statuslineSource: path.join(REPO_SCRIPTS, STATUSLINE_FILE),
  });
  const registrar = new McpRegistrar({
    configDir,
    homeDir: root,
    env: { ...process.env },
    serverSource: path.join(REPO_SCRIPTS, MCP_SERVER_FILE),
    runClaude: runFakeClaude,
    claudeCommand: CLAUDE,
    nodeCommand: NODE,
  });
  const deps: RemoveHooksDeps = { installer, registrar, forgetConsent: () => forgetConsent(dataDir) };
  return { root, configDir, dataDir, settingsPath, claudeJson: registrar.claudeJsonPath, installer, registrar, deps };
}

async function consentTo(dataDir: string, settingsPath: string) {
  await writeHuddleSettings(dataDir, {
    consentedAt: '2026-11-16T09:00:00.000Z',
    consentedFor: settingsPath,
    consentedFingerprint: 'f'.repeat(64),
    extra: { preferences: { questionHoldSeconds: 42 } },
  });
}

const mine = {
  model: 'sonnet',
  env: { MY_VAR: '1' },
  statusLine: { type: 'command', command: 'my-line' },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
};

describe('removeHooks (the packaged --remove-hooks full clean-up)', () => {
  it('removes hooks, telemetry, the status line bridge, the consent and our MCP server; a second run finds nothing', async () => {
    const s = await setup(mine);
    expect(s.claudeJson.startsWith(s.configDir)).toBe(true);
    await fsp.writeFile(s.claudeJson, JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }));
    const claudeJsonBefore: unknown = JSON.parse(await fsp.readFile(s.claudeJson, 'utf8'));
    // What the app does on attach with the bridge opted in, the opt-in registration, and what a normal quit leaves.
    expect((await s.installer.install({ statusLine: true }, { consent: true })).status).toBe('written');
    expect((await s.installer.uninstall({ removeTelemetry: false }, { consent: true })).status).toBe('written');
    const plan = await s.registrar.prepare('register');
    expect((await s.registrar.apply(plan.preview, { consent: true })).status).toBe('written');
    expect(await s.registrar.isRegistered()).toBe(true);
    await consentTo(s.dataDir, s.settingsPath);

    const result = await removeHooks(s.deps, { alreadyRunning: false });
    expect(result.ok).toBe(true);
    expect(result.title).toBe(REMOVE_HOOKS_WORDS.removedTitle);
    expect(result.lines).toContain(REMOVE_HOOKS_WORDS.mcpRemoved);
    expect(result.lines).toContain(REMOVE_HOOKS_WORDS.consentForgotten);
    expect(result.lines.some((l) => l.startsWith('Backup of the file before the change: '))).toBe(true);

    // settings.json is the user's again, .claude.json is deep-equal to before the registration, the copy is gone.
    expect(JSON.parse(await fsp.readFile(s.settingsPath, 'utf8'))).toEqual(mine);
    expect(JSON.parse(await fsp.readFile(s.claudeJson, 'utf8'))).toEqual(claudeJsonBefore);
    expect(existsSync(s.registrar.serverTarget)).toBe(false);
    // The consent is forgotten; the preferences next to it stay.
    const after = await readHuddleSettings(s.dataDir);
    expect(after).toMatchObject({ consentedAt: null, consentedFor: null, consentedFingerprint: null });
    expect(after.extra['preferences']).toEqual({ questionHoldSeconds: 42 });

    const again = await removeHooks(s.deps, { alreadyRunning: false });
    expect(again.ok).toBe(true);
    expect(again.title).toBe(REMOVE_HOOKS_WORDS.nothingTitle);
    expect(again.lines).toContain(REMOVE_HOOKS_WORDS.mcpNone);
    expect(again.lines).toContain(REMOVE_HOOKS_WORDS.consentNone);
  });

  it('leaves a foreign "huddle" MCP server alone and says so', async () => {
    const s = await setup(mine);
    const foreign = { mcpServers: { huddle: { type: 'stdio', command: 'someone-else', args: [], env: {} } } };
    await fsp.writeFile(s.claudeJson, JSON.stringify(foreign));
    const run = vi.fn(runFakeClaude);
    const registrar = new McpRegistrar({
      configDir: s.configDir,
      homeDir: s.root,
      env: { ...process.env },
      serverSource: path.join(REPO_SCRIPTS, MCP_SERVER_FILE),
      runClaude: run,
      claudeCommand: CLAUDE,
    });
    const result = await removeHooks({ ...s.deps, registrar }, { alreadyRunning: false });
    expect(result.ok).toBe(true);
    expect(result.lines).toContain(REMOVE_HOOKS_WORDS.mcpForeign);
    expect(run).not.toHaveBeenCalled();
    expect(JSON.parse(await fsp.readFile(s.claudeJson, 'utf8'))).toEqual(foreign);
  });

  it('refuses while Agent Huddle is running and changes nothing', async () => {
    const s = await setup({});
    await consentTo(s.dataDir, s.settingsPath);
    const uninstall = vi.spyOn(s.installer, 'uninstall');
    const removeMcp = vi.spyOn(s.registrar, 'removeIfOurs');
    const forget = vi.fn(s.deps.forgetConsent);
    const result = await removeHooks({ ...s.deps, forgetConsent: forget }, { alreadyRunning: true });
    expect(result).toEqual({ ok: false, title: 'Agent Huddle is running', lines: [REMOVE_HOOKS_WORDS.running] });
    expect(uninstall).not.toHaveBeenCalled();
    expect(removeMcp).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    expect((await readHuddleSettings(s.dataDir)).consentedAt).not.toBeNull();
  });

  it('an unreadable settings.json is left as it is and reported; the other steps still run', async () => {
    const s = await setup({});
    await fsp.writeFile(s.settingsPath, '{ not json');
    await consentTo(s.dataDir, s.settingsPath);
    const result = await removeHooks(s.deps, { alreadyRunning: false });
    expect(result.ok).toBe(false);
    expect(result.title).toBe(REMOVE_HOOKS_WORDS.partialTitle);
    expect(result.lines.some((l) => l.startsWith('Left: the hooks.'))).toBe(true);
    expect(await fsp.readFile(s.settingsPath, 'utf8')).toBe('{ not json');
    // The consent is cleared first anyway: the next start asks again, the safe direction.
    expect((await readHuddleSettings(s.dataDir)).consentedAt).toBeNull();
  });

  it('a failing claude mcp remove is reported as left, not as removed', async () => {
    const s = await setup({});
    const plan = await s.registrar.prepare('register');
    expect((await s.registrar.apply(plan.preview, { consent: true })).status).toBe('written');
    const failing = new McpRegistrar({
      configDir: s.configDir,
      homeDir: s.root,
      env: { ...process.env, FAKE_MCP_FAIL: '1' },
      serverSource: path.join(REPO_SCRIPTS, MCP_SERVER_FILE),
      runClaude: runFakeClaude,
      claudeCommand: CLAUDE,
    });
    const result = await removeHooks({ ...s.deps, registrar: failing }, { alreadyRunning: false });
    expect(result.ok).toBe(false);
    expect(result.lines.some((l) => l.startsWith('Left: the self-report MCP server.'))).toBe(true);
    expect(result.lines).not.toContain(REMOVE_HOOKS_WORDS.mcpRemoved);
    expect(await s.registrar.isRegistered()).toBe(true);
  });

  it('a missing or unreadable app settings file is never rewritten', async () => {
    const s = await setup({});
    expect(await forgetConsent(s.dataDir)).toMatchObject({ forgotten: false });
    expect(existsSync(path.join(s.dataDir, 'huddle-settings.json'))).toBe(false);
    await fsp.mkdir(s.dataDir, { recursive: true });
    await fsp.writeFile(path.join(s.dataDir, 'huddle-settings.json'), '{ broken');
    expect(await forgetConsent(s.dataDir)).toMatchObject({ forgotten: false });
    expect(await fsp.readFile(path.join(s.dataDir, 'huddle-settings.json'), 'utf8')).toBe('{ broken');
  });

  it('asks for the full removal', () => {
    expect(FULL_REMOVAL).toEqual({ removeTelemetry: true, restoreStatusLine: true });
  });
});
