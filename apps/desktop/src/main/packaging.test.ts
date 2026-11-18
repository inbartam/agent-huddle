/**
 * M6 P6 packaging: the launch switches, the login item and the electron-builder config staying in step with main.
 * The packaged "remove hooks" command has its own tests (remove-hooks.test.ts).
 */
import { promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APP_USER_MODEL_ID, PRODUCT_NAME, pinnedUserDataPath } from './app-identity.js';
import { FORWARDER_FILE, ICON_FILE, MCP_SERVER_FILE, PHONE_DIR, STATUSLINE_FILE } from './core-config.js';
import { isToolLaunch, parseLaunchMode, selfCheckPathProblem, selfCheckTargetProblem } from './launch-mode.js';
import { createLoginItem, type LoginItemApi } from './login-item.js';

const EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\Agent Huddle\\Agent Huddle.exe';

describe('parseLaunchMode', () => {
  it('is the app without a tool switch, dev or packaged', () => {
    expect(parseLaunchMode([EXE])).toEqual({ kind: 'app' });
    expect(parseLaunchMode(['electron.exe', '.', '--inspect=0'])).toEqual({ kind: 'app' });
    // A switch in argv[0] (the exe itself) does not count.
    expect(parseLaunchMode(['--remove-hooks'])).toEqual({ kind: 'app' });
  });

  it('finds --remove-hooks anywhere after the exe', () => {
    expect(parseLaunchMode([EXE, '--remove-hooks'])).toEqual({ kind: 'remove-hooks' });
    expect(parseLaunchMode([EXE, '--allow-file-access-from-files', '--remove-hooks'])).toEqual({
      kind: 'remove-hooks',
    });
    expect(parseLaunchMode([EXE, '--remove-hooks=yes']).kind).toBe('app');
  });

  it('takes the self-check only with an absolute .json path inside the temp folder', () => {
    const TMP = 'C:\\Users\\u\\AppData\\Local\\Temp';
    expect(parseLaunchMode([EXE, `--huddle-self-check=${TMP}\\s23-x\\s23.json`], TMP)).toEqual({
      kind: 'self-check',
      out: path.normalize(`${TMP}\\s23-x\\s23.json`),
    });
    expect(parseLaunchMode([EXE, '--huddle-self-check'], TMP).kind).toBe('invalid');
    expect(parseLaunchMode([EXE, '--huddle-self-check=report.json'], TMP).kind).toBe('invalid');
    expect(parseLaunchMode([EXE, `--huddle-self-check=${TMP}\\s23.txt`], TMP).kind).toBe('invalid');
    // Outside the temp folder: Claude Code's files, the home folder, a ".." escape, a sibling, another drive.
    for (const out of [
      'C:\\Users\\u\\.claude\\settings.json',
      'C:\\Users\\u\\.claude.json',
      'C:\\Users\\u\\notes.json',
      `${TMP}\\..\\..\\..\\.claude\\settings.json`,
      `${TMP}.json`,
      'D:\\Temp\\s23.json',
    ]) {
      expect(parseLaunchMode([EXE, `--huddle-self-check=${out}`], TMP).kind, out).toBe('invalid');
    }
    // Named .claude.json, even inside the temp folder (any case).
    expect(selfCheckPathProblem(`${TMP}\\.CLAUDE.json`, TMP)).toMatch(/\.claude\.json/);
    // Case does not matter on Windows.
    expect(selfCheckPathProblem('c:\\users\\U\\appdata\\local\\temp\\a.json', TMP)).toBeNull();
    // A refused self-check is still a tool launch: the running instance does not open its window for it.
    expect(isToolLaunch([EXE, '--huddle-self-check=C:\\Users\\u\\.claude\\settings.json'])).toBe(true);
  });

  it('checks the target again with links resolved: temp only, never in the Claude folder, folder must exist', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-selfcheck-'));
    try {
      const claudeDir = path.join(tmp, 'claude-config');
      await fsp.mkdir(claudeDir);
      const opts = { tmpDir: os.tmpdir(), claudeConfigDir: claudeDir, realpath: (p: string) => fsp.realpath(p) };
      // The S23 harness case: a new file in a fresh temp folder.
      expect(await selfCheckTargetProblem(path.join(tmp, 's23.json'), opts)).toBeNull();
      // Claude Code's folder, even when it lives in the temp folder (CLAUDE_CONFIG_DIR).
      expect(await selfCheckTargetProblem(path.join(claudeDir, 'settings.json'), opts)).toMatch(/Claude Code/);
      // A folder that does not exist.
      expect(await selfCheckTargetProblem(path.join(tmp, 'missing', 's23.json'), opts)).toMatch(/must already exist/);
      // A link in the temp folder that leads outside it (a fake realpath stands in for a junction).
      const linked = path.join(tmp, 'link');
      const viaLink = (p: string) => (p === linked ? Promise.resolve('C:\\Users\\u\\.claude') : fsp.realpath(p));
      expect(await selfCheckTargetProblem(path.join(linked, 'settings.json'), { ...opts, realpath: viaLink })).toMatch(
        /temp folder/,
      );
      // The write itself uses 'wx' (index.ts): an existing report is refused, not overwritten.
      const existing = path.join(tmp, 'exists.json');
      await fsp.writeFile(existing, 'keep');
      await expect(fsp.writeFile(existing, 'new', { flag: 'wx' })).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await fsp.readFile(existing, 'utf8')).toBe('keep');
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('marks tool launches so the running instance does not open the main window for them', () => {
    expect(isToolLaunch([EXE, '--remove-hooks'])).toBe(true);
    expect(isToolLaunch([EXE])).toBe(false);
  });
});

function fakeLoginApi() {
  let item = { openAtLogin: false, executableWillLaunchAtLogin: false };
  const set = vi.fn((s: Parameters<LoginItemApi['setLoginItemSettings']>[0]) => {
    item = { openAtLogin: s.openAtLogin, executableWillLaunchAtLogin: s.openAtLogin && s.enabled };
  });
  const api: LoginItemApi = {
    getLoginItemSettings: () => item,
    setLoginItemSettings: set,
  };
  return {
    api,
    set,
    disableInTaskManager: () => {
      item = { ...item, executableWillLaunchAtLogin: false };
    },
  };
}

describe('createLoginItem', () => {
  const env = { packaged: true, platform: 'win32' as const, execPath: EXE, appUserModelId: APP_USER_MODEL_ID };

  it('is absent in a dev run and on other platforms', () => {
    expect(createLoginItem(fakeLoginApi().api, { ...env, packaged: false })).toBeNull();
    expect(createLoginItem(fakeLoginApi().api, { ...env, platform: 'darwin' })).toBeNull();
  });

  it('is off by default and writes the installed exe, no arguments, under the AppUserModelID', () => {
    const fake = fakeLoginApi();
    const item = createLoginItem(fake.api, env);
    expect(item?.get()).toBe(false);
    item?.set(true);
    expect(fake.set).toHaveBeenCalledWith({
      openAtLogin: true,
      enabled: true,
      path: EXE,
      args: [],
      name: APP_USER_MODEL_ID,
    });
    expect(item?.get()).toBe(true);
    item?.set(false);
    expect(item?.get()).toBe(false);
  });

  it('reads as off when Task Manager disabled the run key', () => {
    const fake = fakeLoginApi();
    const item = createLoginItem(fake.api, env);
    item?.set(true);
    fake.disableInTaskManager();
    expect(item?.get()).toBe(false);
  });
});

describe('electron-builder.json', () => {
  interface Builder {
    appId: string;
    productName: string;
    electronVersion: string;
    asar: boolean;
    publish: unknown;
    files: string[];
    extraResources: { from: string; to: string }[];
    nsis: Record<string, unknown>;
  }
  const config = JSON.parse(readFileSync(new URL('../../electron-builder.json', import.meta.url), 'utf8')) as Builder;

  it('uses the AppUserModelID main sets, so toasts and the Start menu shortcut match', () => {
    expect(config.appId).toBe(APP_USER_MODEL_ID);
    expect(config.productName).toBe(PRODUCT_NAME);
  });

  it('installs into "Agent Huddle" (a one-click per-user NSIS folder is named after the package name), data pinned', () => {
    expect((config as unknown as { extraMetadata?: { name?: string } }).extraMetadata?.name).toBe(PRODUCT_NAME);
    const j = (...p: string[]) => p.join('\\');
    // The rename would move Electron's default data folder; main pins it where dev keeps it (shared, owner decision).
    expect(pinnedUserDataPath('C:\\Users\\u\\AppData\\Roaming', false, j)).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\@huddle\\desktop',
    );
    // An explicit --user-data-dir (the exit harness's temp folder) always wins.
    expect(pinnedUserDataPath('C:\\Users\\u\\AppData\\Roaming', true, j)).toBeNull();
  });

  it('is version 0.6.0 (M6, owner decision); the installer name follows package.json, nothing pins another', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.6.0');
    expect(JSON.stringify(config)).not.toMatch(/"(buildVersion|version|artifactName)"/);
  });

  it('pins the Electron version that is installed', () => {
    const installed = JSON.parse(
      readFileSync(new URL('../../../../node_modules/electron/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(config.electronVersion).toBe(installed.version);
  });

  it('ships every file main looks for in resources, outside app.asar', () => {
    expect(config.asar).toBe(true);
    const targets = config.extraResources.map((r) => r.to).sort();
    expect(targets).toEqual([FORWARDER_FILE, MCP_SERVER_FILE, STATUSLINE_FILE, PHONE_DIR, ICON_FILE].sort());
    // The phone page is not also packed into the asar.
    expect(config.files.some((f) => f.includes('phone'))).toBe(false);
  });

  it('has no update feed and keeps the app data folder on uninstall (ADR-026)', () => {
    expect(config.publish).toBeNull();
    expect(config.nsis['perMachine']).toBe(false);
    expect(config.nsis['deleteAppDataOnUninstall']).toBe(false);
  });

  it('removes the login item on uninstall under the same name main writes', () => {
    const nsh = readFileSync(new URL('../../build/installer.nsh', import.meta.url), 'utf8');
    expect(nsh).toContain(`"Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${APP_USER_MODEL_ID}"`);
    // The uninstaller never names the Claude Code folder or its settings file in a command.
    expect(nsh.split('\n').filter((l) => !l.trim().startsWith(';') && /\.claude/.test(l))).toEqual([]);
  });
});
