import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseCore, claudeConfigDirOf, shippedFiles, uninstallCommandOf, type CoreEnv } from './core-config.js';

const base: CoreEnv = {
  packaged: false,
  appPath: path.join('C:', 'repo', 'apps', 'desktop'),
  resourcesPath: path.join('C:', 'Program Files', 'Huddle', 'resources'),
  userData: path.join('C:', 'Users', 'u', 'AppData', 'Roaming', 'Huddle'),
  homedir: path.join('C:', 'Users', 'u'),
  env: {},
  execPath: path.join('C:', 'Users', 'u', 'AppData', 'Local', 'Programs', 'Agent Huddle', 'Agent Huddle.exe'),
};

describe('chooseCore', () => {
  it('uses the real core with ~/.claude and the repo forwarder in dev', () => {
    const c = chooseCore(base);
    if (c.kind !== 'huddle') throw new Error('expected the real core');
    expect(c.deps.claudeConfigDir).toBe(path.join('C:', 'Users', 'u', '.claude'));
    expect(c.deps.userAgentsDir).toBe(path.join('C:', 'Users', 'u', '.claude', 'agents'));
    expect(c.deps.dataDir).toBe(base.userData);
    expect(c.deps.cwd).toBeNull();
    expect(c.deps.forwarderSource).toBe(path.join('C:', 'repo', 'scripts', 'huddle-forward-hook.mjs'));
    expect(c.deps.statuslineSource).toBe(path.join('C:', 'repo', 'scripts', 'huddle-statusline.mjs'));
    expect(c.deps.phone).toEqual({ staticDir: path.join('C:', 'repo', 'apps', 'desktop', 'out', 'phone') });
    expect(c.deps.uninstallCommand).toBe(
      `node "${path.join('C:', 'repo', 'scripts', 'install-hooks.mjs')}" --uninstall --apply`,
    );
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    const c = chooseCore({ ...base, env: { CLAUDE_CONFIG_DIR: path.join('D:', 'tmp', 'cfg') } });
    if (c.kind !== 'huddle') throw new Error('expected the real core');
    expect(c.deps.claudeConfigDir).toBe(path.join('D:', 'tmp', 'cfg'));
    expect(c.deps.userAgentsDir).toBe(path.join('D:', 'tmp', 'cfg', 'agents'));
  });

  it('serves canned data only in an unpackaged run with HUDDLE_DEV_CANNED=1', () => {
    expect(chooseCore({ ...base, env: { HUDDLE_DEV_CANNED: '1' } }).kind).toBe('canned');
    expect(chooseCore({ ...base, env: { HUDDLE_DEV_CANNED: 'true' } }).kind).toBe('huddle');
    expect(chooseCore({ ...base, packaged: true, env: { HUDDLE_DEV_CANNED: '1' } }).kind).toBe('huddle');
  });

  it('takes every shipped file from resources, outside app.asar, when packaged (P6 extraResources)', () => {
    const packaged: CoreEnv = { ...base, packaged: true, appPath: path.join(base.resourcesPath, 'app.asar') };
    const c = chooseCore(packaged);
    if (c.kind !== 'huddle') throw new Error('expected the real core');
    expect(c.deps.forwarderSource).toBe(path.join(base.resourcesPath, 'huddle-forward-hook.mjs'));
    expect(c.deps.statuslineSource).toBe(path.join(base.resourcesPath, 'huddle-statusline.mjs'));
    expect(c.deps.mcpServerSource).toBe(path.join(base.resourcesPath, 'huddle-mcp.mjs'));
    // The phone page must be real files outside app.asar (P6 copies out/phone there as an extra resource).
    expect(c.deps.phone).toEqual({ staticDir: path.join(base.resourcesPath, 'phone') });
    for (const p of [c.deps.forwarderSource, c.deps.statuslineSource ?? '', c.deps.mcpServerSource ?? '']) {
      expect(p.includes('app.asar')).toBe(false);
    }
    expect(shippedFiles(packaged).icon).toBe(path.join(base.resourcesPath, 'tray.ico'));
  });

  it('names the installed exe with --remove-hooks as the packaged "remove hooks" command', () => {
    const c = chooseCore({ ...base, packaged: true });
    if (c.kind !== 'huddle') throw new Error('expected the real core');
    expect(c.deps.uninstallCommand).toBe(`& "${base.execPath}" --remove-hooks`);
    // The forwarder ignores a command longer than 500 characters.
    expect((c.deps.uninstallCommand ?? '').length).toBeLessThanOrEqual(500);
  });

  it('takes the MCP server and the icon from the repo in dev', () => {
    const files = shippedFiles(base);
    expect(files.mcpServer).toBe(path.join('C:', 'repo', 'scripts', 'huddle-mcp.mjs'));
    expect(files.icon).toBe(path.join('C:', 'repo', 'apps', 'desktop', 'resources', 'tray.ico'));
  });

  it('ignores a blank CLAUDE_CONFIG_DIR', () => {
    expect(claudeConfigDirOf({ homedir: base.homedir, env: { CLAUDE_CONFIG_DIR: '  ' } })).toBe(
      path.join('C:', 'Users', 'u', '.claude'),
    );
  });
});

describe('uninstallCommandOf quoting (A2-06, A6-09)', () => {
  it('keeps double quotes for an ordinary path', () => {
    expect(uninstallCommandOf({ ...base, packaged: true })).toBe(`& "${base.execPath}" --remove-hooks`);
  });

  it('uses single quotes when the path holds a dollar sign or a backtick, so no shell expands it', () => {
    const execPath = path.join('C:', 'Users', 'a$b', 'Agent Huddle', 'Agent Huddle.exe');
    expect(uninstallCommandOf({ ...base, packaged: true, execPath })).toBe(`& '${execPath}' --remove-hooks`);
    const appPath = path.join('C:', 'Users', 'a`b', 'repo', 'apps', 'desktop');
    const dev = uninstallCommandOf({ ...base, appPath });
    expect(dev).toBe(
      `node '${path.join('C:', 'Users', 'a`b', 'repo', 'scripts', 'install-hooks.mjs')}' --uninstall --apply`,
    );
  });

  it('doubles a single quote inside the PowerShell form', () => {
    const execPath = path.join('C:', 'Users', "o'a$b", 'Agent Huddle.exe');
    expect(uninstallCommandOf({ ...base, packaged: true, execPath })).toBe(
      `& '${execPath.replaceAll("'", "''")}' --remove-hooks`,
    );
  });
});
