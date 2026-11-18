/**
 * Resolving `claude` to an absolute path (security review M2). The real file system in os.tmpdir(); the PATH is
 * given in the env, so nothing of the machine's own PATH is read.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_NOT_FOUND_MESSAGE,
  CLAUDE_SHIM_ONLY_MESSAGE,
  claudePathEntries,
  resolveClaudeExecutable,
} from './claude-path.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-claude-path-')));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function dirWith(name: string, files: string[]): Promise<string> {
  const dir = path.join(tmp, name);
  await fsp.mkdir(dir, { recursive: true });
  for (const f of files) await fsp.writeFile(path.join(dir, f), 'not really claude\n', { mode: 0o755 });
  return dir;
}

describe('claudePathEntries (pure)', () => {
  it('reads PATH case-insensitively on Windows, strips quotes, keeps order', () => {
    expect(claudePathEntries({ Path: 'C:\\a;"C:\\Program Files\\b";D:\\c' }, 'win32')).toEqual([
      'C:\\a',
      'C:\\Program Files\\b',
      'D:\\c',
    ]);
  });

  it('skips empty, ".", relative, drive-relative, rooted-without-drive, UNC and device entries', () => {
    const PATH = ['', '.', '.\\bin', 'bin', 'C:rel', '\\rooted', '\\\\host\\share', '\\\\?\\C:\\x', 'C:\\ok', ';'].join(
      ';',
    );
    expect(claudePathEntries({ PATH }, 'win32')).toEqual(['C:\\ok']);
    expect(claudePathEntries({ PATH: ':.:bin:/usr/bin::./x:/opt/claude' }, 'linux')).toEqual([
      '/usr/bin',
      '/opt/claude',
    ]);
  });

  it('no PATH at all is no entries', () => {
    expect(claudePathEntries({}, 'win32')).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'win32')('resolveClaudeExecutable on Windows', () => {
  it('ignores a claude.exe in a relative, "." or empty PATH entry and picks the one on an absolute entry', async () => {
    const planted = await dirWith('repo', ['claude.exe', 'claude.com']);
    const real = await dirWith('bin', ['claude.exe']);
    const rel = path.relative(process.cwd(), planted);
    const entries = ['', '.', planted.replace(/^[A-Za-z]:/, ''), real];
    if (!path.isAbsolute(rel)) entries.unshift(rel);
    const got = await resolveClaudeExecutable({ env: { PATH: entries.join(';') }, platform: 'win32' });
    expect(got).toEqual({ ok: true, path: path.join(real, 'claude.exe') });
  });

  it('takes the first PATH folder that has it; .com before .exe in one folder (the Windows PATHEXT order)', async () => {
    const first = await dirWith('first', ['claude.exe']);
    const second = await dirWith('second', ['claude.com', 'claude.exe']);
    expect(await resolveClaudeExecutable({ env: { Path: `${first};${second}` }, platform: 'win32' })).toEqual({
      ok: true,
      path: path.join(first, 'claude.exe'),
    });
    expect(await resolveClaudeExecutable({ env: { Path: second }, platform: 'win32' })).toEqual({
      ok: true,
      path: path.join(second, 'claude.com'),
    });
  });

  it('never takes a bare "claude" file or a folder named claude.exe', async () => {
    const bare = await dirWith('bare', ['claude']);
    const folder = path.join(tmp, 'folder');
    await fsp.mkdir(path.join(folder, 'claude.exe'), { recursive: true });
    const got = await resolveClaudeExecutable({ env: { PATH: `${bare};${folder}` }, platform: 'win32' });
    expect(got).toEqual({ ok: false, reason: 'not_found', message: CLAUDE_NOT_FOUND_MESSAGE });
  });

  it('only a .cmd / .bat / .ps1 shim: a clear error, not the shim', async () => {
    for (const shim of ['claude.cmd', 'claude.bat', 'claude.ps1']) {
      const dir = await dirWith(`npm-${shim}`, [shim]);
      expect(await resolveClaudeExecutable({ env: { PATH: dir }, platform: 'win32' }), shim).toEqual({
        ok: false,
        reason: 'shim_only',
        message: CLAUDE_SHIM_ONLY_MESSAGE,
      });
    }
    // A native install later on PATH wins over an npm shim earlier on it.
    const npm = await dirWith('npm', ['claude.cmd', 'claude.ps1', 'claude']);
    const native = await dirWith('native', ['claude.exe']);
    expect(await resolveClaudeExecutable({ env: { PATH: `${npm};${native}` }, platform: 'win32' })).toEqual({
      ok: true,
      path: path.join(native, 'claude.exe'),
    });
  });

  it('not found anywhere: not_found with a clear message', async () => {
    const empty = await dirWith('empty', []);
    expect(
      await resolveClaudeExecutable({ env: { PATH: `${empty};${path.join(tmp, 'missing')}` }, platform: 'win32' }),
    ).toEqual({ ok: false, reason: 'not_found', message: CLAUDE_NOT_FOUND_MESSAGE });
    expect(await resolveClaudeExecutable({ env: {}, platform: 'win32' })).toMatchObject({ reason: 'not_found' });
  });
});

describe.skipIf(process.platform === 'win32')('resolveClaudeExecutable on POSIX', () => {
  it('takes an executable claude on an absolute PATH entry, never a relative one', async () => {
    const planted = await dirWith('repo', ['claude']);
    const real = await dirWith('bin', ['claude']);
    const got = await resolveClaudeExecutable({
      env: { PATH: `.:${path.relative(process.cwd(), planted)}::${real}` },
      platform: process.platform,
    });
    expect(got).toEqual({ ok: true, path: path.join(real, 'claude') });
  });

  it('a claude that is not executable is skipped', async () => {
    const dir = await dirWith('noexec', ['claude']);
    await fsp.chmod(path.join(dir, 'claude'), 0o644);
    expect(await resolveClaudeExecutable({ env: { PATH: dir }, platform: process.platform })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });
});
