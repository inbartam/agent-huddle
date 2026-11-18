/** Status line bridge in the installer (F9, ADR-018). Temp config folders only; never the real ~/.claude. */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HookInstaller,
  STATUSLINE_ORIGINAL_FILENAME,
  STATUSLINE_WRAPPER_FILENAME,
  formatDiff,
  isHuddleStatusLine,
  planInstall,
  planUninstall,
  serializeSettings,
  type InstallOptions,
} from './install-hooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FORWARDER_SOURCE = path.resolve(here, '../../../../scripts/huddle-forward-hook.mjs');
const STATUSLINE_SOURCE = path.resolve(here, '../../../../scripts/huddle-statusline.mjs');
const TOKEN = 'test-token-0123456789';
const PORT = 47821;

const USER_LINE = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 2, refreshInterval: 5 };
const USER_SETTINGS = {
  theme: 'dark',
  statusLine: USER_LINE,
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-guard.js' }] }] },
  env: { MY_VAR: '1' },
};

const tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-sl-setup-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

function installer(configDir: string, withSource = true) {
  let t = Date.UTC(2026, 10, 14, 1, 0, 0);
  return new HookInstaller({
    configDir,
    now: () => new Date((t += 1000)),
    newToken: () => TOKEN,
    forwarderSource: FORWARDER_SOURCE,
    ...(withSource ? { statuslineSource: STATUSLINE_SOURCE } : {}),
  });
}

async function writeSettings(dir: string, value: object): Promise<string> {
  const text = serializeSettings(value as Record<string, unknown>);
  await fsp.writeFile(path.join(dir, 'settings.json'), text);
  return text;
}

async function readSettings(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
}

async function exists(file: string): Promise<boolean> {
  return fsp.access(file).then(
    () => true,
    () => false,
  );
}

const WRAPPER = 'C:/Users/user/.claude/agent-huddle/huddle-statusline.mjs';
const planOptions: InstallOptions = {
  port: PORT,
  token: TOKEN,
  forwarderPath: 'C:/Users/user/.claude/agent-huddle/huddle-forward-hook.mjs',
  statusLine: true,
  statuslineWrapperPath: WRAPPER,
};

describe('ownership of statusLine', () => {
  it('is ours only for exactly the bridge command', () => {
    expect(isHuddleStatusLine({ type: 'command', command: `node "${WRAPPER}"` })).toBe(true);
    expect(isHuddleStatusLine({ type: 'command', command: `node "${WRAPPER}" && echo x` })).toBe(false);
    expect(isHuddleStatusLine({ type: 'command', command: `bash "${WRAPPER}"` })).toBe(false);
    expect(isHuddleStatusLine({ type: 'text', command: `node "${WRAPPER}"` })).toBe(false);
    expect(isHuddleStatusLine(USER_LINE)).toBe(false);
    expect(isHuddleStatusLine(null)).toBe(false);
  });
});

describe('planInstall / planUninstall with statusLine', () => {
  it('default (no statusLine option) never touches statusLine', () => {
    const plan = planInstall(USER_SETTINGS, { ...planOptions, statusLine: false });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.after.statusLine).toEqual(USER_LINE);
    expect(plan.statusLineToSave).toBeUndefined();
  });

  it('wraps the user line in place, keeps padding and refreshInterval, and saves the original exactly', () => {
    const plan = planInstall(USER_SETTINGS, planOptions);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.after.statusLine).toEqual({
      type: 'command',
      command: `node "${WRAPPER}"`,
      padding: 2,
      refreshInterval: 5,
    });
    // Same key position as before.
    expect(Object.keys(plan.after).indexOf('statusLine')).toBe(Object.keys(USER_SETTINGS).indexOf('statusLine'));
    expect(plan.statusLineToSave).toEqual({ statusLine: USER_LINE });
    expect(plan.notes.join('\n')).toContain('wrap your status line');
  });

  it('is idempotent: re-planning over an installed bridge changes nothing and saves nothing new', () => {
    const first = planInstall(USER_SETTINGS, planOptions);
    if (!first.ok) throw new Error(first.error);
    const again = planInstall(first.after, planOptions);
    if (!again.ok) throw new Error(again.error);
    expect(again.changed).toBe(false);
    expect(again.statusLineToSave).toBeUndefined();
  });

  it('no line before: saves "none"; uninstall then removes the key', () => {
    const plan = planInstall({ theme: 'dark' }, planOptions);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.statusLineToSave).toEqual({ statusLine: null });
    const back = planUninstall(plan.after, { restoreStatusLine: true, statusLineOriginal: { statusLine: null } });
    if (!back.ok) throw new Error(back.error);
    expect('statusLine' in back.after).toBe(false);
  });

  it('uninstall without restoreStatusLine (quit) keeps the bridge', () => {
    const plan = planInstall(USER_SETTINGS, planOptions);
    if (!plan.ok) throw new Error(plan.error);
    const quit = planUninstall(plan.after, {});
    if (!quit.ok) throw new Error(quit.error);
    expect(isHuddleStatusLine(quit.after.statusLine)).toBe(true);
    expect(quit.forgetStatusLineOriginal).toBeUndefined();
  });

  it('restore keeps padding / refreshInterval the user changed on the bridge since install; unchanged keys come back', () => {
    const plan = planInstall(USER_SETTINGS, planOptions);
    if (!plan.ok) throw new Error(plan.error);
    const bridge = plan.after.statusLine as Record<string, unknown>;
    expect(bridge).toMatchObject({ padding: 2, refreshInterval: 5 });
    // The user edits the bridge entry: new padding, refreshInterval removed, hideVimModeIndicator added.
    const edited = {
      ...plan.after,
      statusLine: { type: 'command', command: bridge.command, padding: 0, hideVimModeIndicator: true },
    };
    const back = planUninstall(edited, { restoreStatusLine: true, statusLineOriginal: plan.statusLineToSave });
    if (!back.ok) throw new Error(back.error);
    expect(back.after.statusLine).toEqual({
      type: 'command',
      command: USER_LINE.command,
      padding: 0,
      hideVimModeIndicator: true,
    });
    expect(back.notes.join('\n')).toMatch(/keep the padding, refreshInterval, hideVimModeIndicator you set/);

    // Untouched bridge: the original exactly, no extra note.
    const plain = planUninstall(plan.after, { restoreStatusLine: true, statusLineOriginal: plan.statusLineToSave });
    if (!plain.ok) throw new Error(plain.error);
    expect(JSON.stringify(plain.after.statusLine)).toBe(JSON.stringify(USER_LINE));
    expect(plain.notes.join('\n')).not.toContain('you set on the bridge');
  });

  it('a missing saved original removes the bridge and warns', () => {
    const plan = planInstall(USER_SETTINGS, planOptions);
    if (!plan.ok) throw new Error(plan.error);
    const back = planUninstall(plan.after, { restoreStatusLine: true, statusLineOriginal: null });
    if (!back.ok) throw new Error(back.error);
    expect('statusLine' in back.after).toBe(false);
    expect(back.warnings.join('\n')).toContain('missing');
  });
});

describe('HookInstaller round trip in a temp config folder', () => {
  it('install -> uninstall gives the original statusLine byte for byte, and the original settings file', async () => {
    const dir = await tmpDir();
    const originalText = await writeSettings(dir, USER_SETTINGS);
    const inst = installer(dir);

    const preview = await inst.prepareInstall({ port: PORT, token: TOKEN, statusLine: true });
    if ('ok' in preview) throw new Error(preview.error);
    const diff = formatDiff(preview.diff);
    expect(diff).toMatch(/^\+ .*huddle-statusline\.mjs/m);
    expect(diff).toMatch(/^- .*statusline\.sh/m);

    expect((await inst.apply(preview, { consent: true })).status).toBe('written');
    const installed = await readSettings(dir);
    expect(isHuddleStatusLine(installed.statusLine)).toBe(true);
    expect(await exists(path.join(dir, 'agent-huddle', STATUSLINE_WRAPPER_FILENAME))).toBe(true);
    const savedPath = path.join(dir, 'agent-huddle', STATUSLINE_ORIGINAL_FILENAME);
    const saved = JSON.parse(await fsp.readFile(savedPath, 'utf8')) as { statusLine: unknown };
    expect(saved.statusLine).toEqual(USER_LINE);

    // Re-install is idempotent and keeps the saved original.
    expect((await inst.install({ port: PORT, token: TOKEN, statusLine: true }, { consent: true })).status).toBe(
      'unchanged',
    );
    // An attach without the option (every app start) leaves the bridge as it is.
    expect((await inst.install({ port: PORT, token: TOKEN }, { consent: true })).status).toBe('unchanged');
    // Quit (detach) keeps the bridge (ADR-018).
    await inst.uninstall({ removeTelemetry: false }, { consent: true });
    expect(isHuddleStatusLine((await readSettings(dir)).statusLine)).toBe(true);
    expect(await exists(savedPath)).toBe(true);

    // Full uninstall restores the original exactly.
    expect((await inst.uninstall({ removeTelemetry: true, restoreStatusLine: true }, { consent: true })).status).toBe(
      'written',
    );
    const afterText = await fsp.readFile(path.join(dir, 'settings.json'), 'utf8');
    const restored = JSON.parse(afterText) as Record<string, unknown>;
    expect(JSON.stringify(restored.statusLine)).toBe(JSON.stringify(USER_LINE));
    expect(afterText).toBe(originalText);
    expect(await exists(savedPath)).toBe(false);
  });

  it('no statusLine before: uninstall removes the key', async () => {
    const dir = await tmpDir();
    const originalText = await writeSettings(dir, { theme: 'dark' });
    const inst = installer(dir);
    await inst.install({ port: PORT, token: TOKEN, statusLine: true, otel: false }, { consent: true });
    expect(isHuddleStatusLine((await readSettings(dir)).statusLine)).toBe(true);
    await inst.uninstall({ restoreStatusLine: true }, { consent: true });
    const after = await readSettings(dir);
    expect('statusLine' in after).toBe(false);
    expect(await fsp.readFile(path.join(dir, 'settings.json'), 'utf8')).toBe(originalText);
  });

  it('a statusLine the user changed after install is left alone, and the uninstall says so', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    const inst = installer(dir);
    await inst.install({ port: PORT, token: TOKEN, statusLine: true }, { consent: true });
    const mine = { type: 'command', command: 'my-new-line', padding: 0 };
    await writeSettings(dir, { ...(await readSettings(dir)), statusLine: mine });

    const prepared = await inst.prepareUninstall({ restoreStatusLine: true });
    if ('ok' in prepared) throw new Error(prepared.error);
    expect(prepared.plan.notes.join('\n')).toContain('changed after the Huddle installed');
    await inst.apply(prepared, { consent: true });
    expect((await readSettings(dir)).statusLine).toEqual(mine);
  });

  it('removing only the bridge (keepHooks) leaves the Huddle hooks', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    const inst = installer(dir);
    await inst.install({ port: PORT, token: TOKEN, statusLine: true }, { consent: true });
    const before = await readSettings(dir);
    await inst.uninstall({ restoreStatusLine: true, keepHooks: true }, { consent: true });
    const after = await readSettings(dir);
    expect(after.statusLine).toEqual(USER_LINE);
    expect(after.hooks).toEqual(before.hooks);
    expect(after.env).toEqual(before.env);
  });

  it('a status line changed between preview and consent makes the change stale (nothing written)', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    const inst = installer(dir);
    const preview = await inst.prepareInstall({ port: PORT, token: TOKEN, statusLine: true });
    if ('ok' in preview) throw new Error(preview.error);
    const other = { type: 'command', command: 'other-line' };
    await writeSettings(dir, { ...USER_SETTINGS, statusLine: other });
    const result = await inst.apply(preview, { consent: true });
    expect(result.status).toBe('stale');
    expect((await readSettings(dir)).statusLine).toEqual(other);
    expect(await exists(path.join(dir, 'agent-huddle', STATUSLINE_ORIGINAL_FILENAME))).toBe(false);
  });

  it('writes the wrapper and forwarder owner-only and tightens an existing agent-huddle folder', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    const huddleDir = path.join(dir, 'agent-huddle');
    await fsp.mkdir(huddleDir, { mode: 0o755 }); // already there, too open: mkdir's mode would not apply
    const writes: { file: string; mode: unknown }[] = [];
    const realWrite = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, 'writeFile').mockImplementation(((file: string, data: string, opts?: { mode?: number }) => {
      writes.push({ file, mode: opts?.mode });
      return realWrite(file, data, opts);
    }) as typeof fsp.writeFile);
    const chmod = vi.spyOn(fsp, 'chmod');
    await installer(dir).install({ port: PORT, token: TOKEN, statusLine: true }, { consent: true });

    expect(chmod).toHaveBeenCalledWith(huddleDir, 0o700);
    for (const name of [STATUSLINE_WRAPPER_FILENAME, 'huddle-forward-hook.mjs']) {
      const write = writes.find((w) => path.basename(w.file).startsWith(`${name}.huddle-tmp-`));
      expect(write?.mode, name).toBe(0o600);
    }
    if (process.platform !== 'win32') {
      // Windows ignores POSIX mode bits; the user-profile ACL protects the files there.
      expect((await fsp.stat(huddleDir)).mode & 0o777).toBe(0o700);
      expect((await fsp.stat(path.join(huddleDir, STATUSLINE_WRAPPER_FILENAME))).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses the option when the build ships no wrapper', async () => {
    const dir = await tmpDir();
    await writeSettings(dir, USER_SETTINGS);
    const prepared = await installer(dir, false).prepareInstall({ port: PORT, token: TOKEN, statusLine: true });
    expect('ok' in prepared && !prepared.ok).toBe(true);
  });
});
