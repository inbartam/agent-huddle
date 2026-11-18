/**
 * HuddleCore + the opt-in self-report registration for attached sessions (M6 P4, F27, ADR-025): the
 * `setup.selfReportPreview` query, the `setup.selfReport.register|unregister` commands (fingerprint = consent to exactly
 * the change shown) and withdraw consent removing it. The fake claude (test/fake-claude-mcp.mjs) edits a temp
 * `.claude.json`; the real `~/.claude.json` is hashed before and after.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResult, SelfReportRegistrationPreview } from '@huddle/shared';
import { consentRecord } from '../test/consent.js';
import { HuddleCore } from './huddle-core.js';
import { writeHuddleSettings } from './huddle-settings.js';
import type { ClaudeRunner } from '../setup/mcp-register.js';

const FAKE = fileURLToPath(new URL('../test/fake-claude-mcp.mjs', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../../../scripts/huddle-mcp.mjs', import.meta.url));
const TOKEN = 'test-token-0123456789';

/** `mcpServers` only: running Claude Code sessions rewrite the rest of the real `~/.claude.json` at any time. */
const hashOf = (file: string): string => {
  if (!existsSync(file)) return 'absent';
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const servers =
      typeof parsed === 'object' && parsed !== null ? ((parsed as { mcpServers?: unknown }).mcpServers ?? null) : null;
    return createHash('sha256').update(JSON.stringify(servers)).digest('hex');
  } catch {
    return 'unreadable';
  }
};
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

const runFake: ClaudeRunner = (_command, args, options) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [FAKE, ...args],
      { env: options.env, cwd: options.cwd, windowsHide: true },
      (e, o, r) => {
        resolve({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : null, stdout: o, stderr: r });
      },
    );
  });

async function start(attach: boolean) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-selfreport-'));
  cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dataDir = path.join(root, 'data');
  const claudeDir = path.join(root, 'claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  await fsp.mkdir(claudeDir, { recursive: true });
  await fsp.writeFile(settingsPath, '{}\n');
  const forwarder = path.join(root, 'forwarder.mjs');
  await fsp.writeFile(forwarder, '// test forwarder\n');
  if (attach) await writeHuddleSettings(dataDir, consentRecord(claudeDir, settingsPath));
  const core = new HuddleCore({
    dataDir,
    claudeConfigDir: claudeDir,
    cwd: null,
    userAgentsDir: null,
    port: 0,
    forwarderSource: forwarder,
    mcpServerSource: SOURCE,
    newToken: () => TOKEN,
    batchIntervalMs: 0,
    selfReportRegistrar: {
      homeDir: path.join(root, 'home'),
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
      runClaude: runFake,
      claudeCommand: path.join(root, 'claude.exe'),
      nodeCommand: process.execPath,
    },
  });
  cleanups.push(() => core.dispose());
  const started = await core.start();
  if (!started.ok) throw new Error(started.message);
  return { core, claudeDir, claudeJson: path.join(claudeDir, '.claude.json') };
}

async function preview(core: HuddleCore, mode: 'register' | 'unregister'): Promise<SelfReportRegistrationPreview> {
  const result: QueryResult = await core.query({ type: 'setup.selfReportPreview', mode });
  if (!result.ok || result.type !== 'setup.selfReportPreview') throw new Error(JSON.stringify(result));
  return result.preview;
}

describe('self-report registration through HuddleCore (F27)', () => {
  it('preview is read-only; register needs the preview fingerprint; unregister undoes it', async () => {
    const { core, claudeDir, claudeJson } = await start(false);
    await fsp.writeFile(claudeJson, JSON.stringify({ keep: true, mcpServers: { other: { command: 'x', args: [] } } }));
    const original = JSON.parse(await fsp.readFile(claudeJson, 'utf8')) as unknown;

    const p = await preview(core, 'register');
    expect(p).toMatchObject({ state: 'absent', changed: true, refusal: null });
    expect(p.commands[0]).toContain('mcp add --scope user huddle --');
    expect(existsSync(path.join(claudeDir, 'agent-huddle', 'huddle-mcp.mjs'))).toBe(false);

    // A command without the fingerprint, or with another one, runs nothing.
    expect((await core.command({ type: 'setup.selfReport.register', fingerprint: 'nope' })).ok).toBe(false);
    expect(await core.command({ type: 'setup.selfReport.register', fingerprint: '0'.repeat(64) })).toMatchObject({
      ok: false,
      code: 'expired',
    });
    expect(JSON.parse(await fsp.readFile(claudeJson, 'utf8'))).toEqual(original);

    expect(await core.command({ type: 'setup.selfReport.register', fingerprint: p.fingerprint })).toEqual({ ok: true });
    expect((await preview(core, 'register')).state).toBe('ours');
    expect(existsSync(path.join(claudeDir, 'agent-huddle', 'huddle-mcp.mjs'))).toBe(true);

    const u = await preview(core, 'unregister');
    expect(u.commands[0]).toContain('mcp remove --scope user huddle');
    expect(await core.command({ type: 'setup.selfReport.unregister', fingerprint: u.fingerprint })).toEqual({
      ok: true,
    });
    expect(JSON.parse(await fsp.readFile(claudeJson, 'utf8'))).toEqual(original);
    expect(existsSync(path.join(claudeDir, 'agent-huddle', 'huddle-mcp.mjs'))).toBe(false);
  });

  it('a huddle server that is not ours: the command is refused and the file stays', async () => {
    const { core, claudeJson } = await start(false);
    const theirs = { mcpServers: { huddle: { command: 'python', args: ['x.py'] } } };
    await fsp.writeFile(claudeJson, JSON.stringify(theirs));
    const p = await preview(core, 'register');
    expect(p.state).toBe('foreign');
    expect(await core.command({ type: 'setup.selfReport.register', fingerprint: p.fingerprint })).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    expect(JSON.parse(await fsp.readFile(claudeJson, 'utf8'))).toEqual(theirs);
  });

  it("withdrawing consent removes the Huddle's registration too", async () => {
    const { core, claudeJson } = await start(true);
    const p = await preview(core, 'register');
    expect((await core.command({ type: 'setup.selfReport.register', fingerprint: p.fingerprint })).ok).toBe(true);
    const result = await core.withdrawConsent();
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.notes?.some((n) => n.includes('claude mcp remove'))).toBe(true);
    const after = JSON.parse(await fsp.readFile(claudeJson, 'utf8')) as { mcpServers?: Record<string, unknown> };
    expect(after.mcpServers?.huddle).toBeUndefined();
  });
});
