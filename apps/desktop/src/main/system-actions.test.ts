import { describe, expect, it, vi } from 'vitest';
import { EMPTY_STATE, type HuddleState } from '@huddle/shared';
import {
  createSystemActions,
  isPlainAbsolutePath,
  isWorktreeFolder,
  vscodeFileUrl,
  worktreePathFor,
  VSCODE_SENT,
  type SystemDeps,
} from './system-actions.js';

const ROOT = 'C:\\Users\\A User\\AppData\\Local\\agent-huddle\\worktrees';
const RUN = `${ROOT}\\run-0001`;
const REPORTS = 'C:\\Users\\A User\\AppData\\Roaming\\agent-huddle\\reports';
const REPORT = `${REPORTS}\\sess-1.md`;

function deps(over: Partial<SystemDeps> = {}) {
  const d = {
    worktreesRoot: ROOT,
    platform: 'win32' as const,
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths: ['C:\\chosen'] })),
    isDirectory: vi.fn(() => Promise.resolve(true)),
    realpath: vi.fn((p: string) => Promise.resolve(p)),
    protocolHandler: vi.fn(() => 'Visual Studio Code'),
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve('')),
    reportsRoot: REPORTS,
    isFile: vi.fn(() => Promise.resolve(true)),
    writeClipboard: vi.fn(() => Promise.resolve()),
    ...over,
  };
  return d;
}

describe('vscode://file/ URL', () => {
  it('uses forward slashes and percent-encodes a Windows path with spaces', () => {
    expect(vscodeFileUrl('C:\\Users\\A User\\AppData\\Local\\agent-huddle\\worktrees\\run-0001')).toBe(
      'vscode://file/C:/Users/A%20User/AppData/Local/agent-huddle/worktrees/run-0001',
    );
  });

  it('encodes #, ? and % so they cannot end or change the path', () => {
    expect(vscodeFileUrl('C:\\a#b\\c?d\\e%20f')).toBe('vscode://file/C:/a%23b/c%3Fd/e%2520f');
  });
});

describe('paths main may touch', () => {
  it('accepts an absolute local path and refuses relative, UNC, device, control characters and non-strings', () => {
    expect(isPlainAbsolutePath('C:\\projects\\x', 'win32')).toBe(true);
    expect(isPlainAbsolutePath('projects\\x', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('\\\\evil-host\\share', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('//evil-host/share', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('\\\\?\\C:\\x', 'win32')).toBe(false);
    // L3: the NT prefix, device namespace, rooted-without-drive and drive-relative forms.
    expect(isPlainAbsolutePath('\\??\\UNC\\evil-host\\share', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('\\??\\C:\\x', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('\\\\.\\pipe\\x', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('\\\\?\\UNC\\evil-host\\share', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('\\rooted\\x', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('C:relative', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('C:\\x\\y:stream', 'win32')).toBe(false);
    expect(isPlainAbsolutePath('C:\\x\u0000y', 'win32')).toBe(false);
    expect(isPlainAbsolutePath(42, 'win32')).toBe(false);
    expect(isPlainAbsolutePath('', 'win32')).toBe(false);
  });

  it('a worktree folder is a direct child of the root, case-insensitive on Windows, never the root or a climb out', () => {
    expect(isWorktreeFolder(ROOT, RUN, 'win32')).toBe(true);
    expect(isWorktreeFolder(ROOT, RUN.toUpperCase().replace(/\\/g, '/'), 'win32')).toBe(true);
    expect(isWorktreeFolder(ROOT, ROOT, 'win32')).toBe(false);
    expect(isWorktreeFolder(ROOT, `${RUN}\\src`, 'win32')).toBe(false);
    expect(isWorktreeFolder(ROOT, `${ROOT}\\..\\elsewhere`, 'win32')).toBe(false);
    expect(isWorktreeFolder(ROOT, `${ROOT}\\run-0001\\..\\..\\..\\Roaming`, 'win32')).toBe(false);
    expect(isWorktreeFolder(ROOT, 'C:\\projects\\repo', 'win32')).toBe(false);
  });
});

describe('openWorktree', () => {
  it('sends a Huddle worktree to VS Code with the vscode://file/ URL, and says sent, not opened', async () => {
    const d = deps();
    await expect(createSystemActions(d).openWorktree(RUN)).resolves.toEqual({ ok: true, detail: VSCODE_SENT });
    expect(VSCODE_SENT).toMatch(/^Sent to VS Code./);
    expect(VSCODE_SENT).not.toMatch(/Opened/);
    expect(d.openExternal).toHaveBeenCalledWith(
      'vscode://file/C:/Users/A%20User/AppData/Local/agent-huddle/worktrees/run-0001',
    );
    expect(d.openPath).not.toHaveBeenCalled();
  });

  it('refuses a path outside the worktrees root and opens nothing', async () => {
    for (const p of [
      'C:\\Windows\\System32',
      `${ROOT}\\..\\x`,
      ROOT,
      `${RUN}\\src`,
      '\\\\host\\share\\run-0001',
      '\\??\\UNC\\host\\share\\run-0001',
      '\\\\?\\C:\\Users\\A User\\AppData\\Local\\agent-huddle\\worktrees\\run-0001',
      '\\\\.\\C:\\Users\\A User\\AppData\\Local\\agent-huddle\\worktrees\\run-0001',
      '\\Users\\A User\\AppData\\Local\\agent-huddle\\worktrees\\run-0001',
      'rel',
    ]) {
      const d = deps();
      await expect(createSystemActions(d).openWorktree(p)).resolves.toMatchObject({ ok: false, code: 'invalid' });
      expect(d.openExternal).not.toHaveBeenCalled();
      expect(d.openPath).not.toHaveBeenCalled();
      expect(d.realpath).not.toHaveBeenCalled();
    }
  });

  it('refuses a run folder that is a link to somewhere else', async () => {
    const d = deps({ realpath: vi.fn((p: string) => Promise.resolve(p === RUN ? 'C:\\Users\\A User\\Documents' : p)) });
    await expect(createSystemActions(d).openWorktree(RUN)).resolves.toMatchObject({ ok: false, code: 'invalid' });
    expect(d.openExternal).not.toHaveBeenCalled();
  });

  it('says the folder is gone when it no longer exists', async () => {
    const d = deps({ realpath: vi.fn(() => Promise.reject(new Error('ENOENT'))) });
    await expect(createSystemActions(d).openWorktree(RUN)).resolves.toMatchObject({ ok: false, code: 'not_found' });
  });

  it('without VS Code, opens the folder in File Explorer and says so', async () => {
    const d = deps({ protocolHandler: vi.fn(() => '') });
    const r = await createSystemActions(d).openWorktree(RUN);
    expect(r).toEqual({ ok: true, detail: "VS Code isn't installed. The folder opened in File Explorer instead." });
    expect(d.openExternal).not.toHaveBeenCalled();
    expect(d.openPath).toHaveBeenCalledWith(RUN);
  });

  it('falls back to File Explorer when the vscode: link fails, and reports when that fails too', async () => {
    const failing = deps({ openExternal: vi.fn(() => Promise.reject(new Error('no handler'))) });
    await expect(createSystemActions(failing).openWorktree(RUN)).resolves.toMatchObject({ ok: true });
    expect(failing.openPath).toHaveBeenCalledWith(RUN);
    const both = deps({ protocolHandler: vi.fn(() => ''), openPath: vi.fn(() => Promise.resolve('Access denied')) });
    await expect(createSystemActions(both).openWorktree(RUN)).resolves.toMatchObject({ ok: false, code: 'failed' });
  });
});

describe('pickFolder', () => {
  it('opens the folder picker parented to the window, with an existing absolute default folder', async () => {
    const d = deps();
    const owner = {} as never;
    await expect(createSystemActions(d).pickFolder('C:\\projects\\x', owner)).resolves.toBe('C:\\chosen');
    expect(d.showOpenDialog).toHaveBeenCalledWith(owner, {
      title: 'Choose the folder to run in',
      properties: ['openDirectory'],
      defaultPath: 'C:\\projects\\x',
    });
  });

  it('leaves out a default that is relative, UNC or not an existing folder (and never stats a UNC path)', async () => {
    for (const [p, exists] of [
      ['projects\\x', true],
      ['\\\\host\\share', true],
      ['\\??\\UNC\\host\\share', true],
      ['\\\\?\\UNC\\host\\share', true],
      ['\\\\.\\pipe\\x', true],
      ['\\rooted', true],
      ['C:\\missing', false],
    ] as const) {
      const d = deps({ isDirectory: vi.fn(() => Promise.resolve(exists)) });
      await createSystemActions(d).pickFolder(p, null);
      expect(d.showOpenDialog).toHaveBeenCalledWith(null, {
        title: 'Choose the folder to run in',
        properties: ['openDirectory'],
      });
      if (p.startsWith('\\')) expect(d.isDirectory, p).not.toHaveBeenCalled();
    }
  });

  it('answers null when the user cancels', async () => {
    const d = deps({ showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })) });
    await expect(createSystemActions(d).pickFolder(undefined, null)).resolves.toBeNull();
  });
});

describe('worktreePathFor', () => {
  const state = (): HuddleState => ({
    ...EMPTY_STATE,
    agents: {
      root: { run: { runId: 'run-0001', worktree: { path: RUN } } } as unknown as HuddleState['agents'][string],
    },
  });

  it("reads the core's { ok: true, detail: <folder> }, else the run's worktree in state", () => {
    expect(worktreePathFor({ ok: true, detail: 'C:\\from-core' }, state(), 'run-0001', 'win32')).toBe('C:\\from-core');
    expect(worktreePathFor({ ok: true, detail: 'canned: acknowledged' }, state(), 'run-0001', 'win32')).toBe(RUN);
    expect(worktreePathFor({ ok: false, code: 'not_found', message: 'x' }, state(), 'run-0001')).toBeNull();
    expect(worktreePathFor({ ok: true }, state(), 'run-0001')).toBe(RUN);
    expect(worktreePathFor({ ok: true }, state(), 'run-other')).toBeNull();
  });
});

describe('openReport and copyReportPath (M5)', () => {
  it('opens a .md file directly inside the reports folder with the system', async () => {
    const d = deps();
    await expect(createSystemActions(d).openReport(REPORT)).resolves.toEqual({ ok: true });
    expect(d.openPath).toHaveBeenCalledWith(REPORT);
  });

  it('refuses anything that is not a report file in the reports folder, before touching the disk', async () => {
    const d = deps();
    const bad = [
      `${REPORTS}\\..\\huddle-settings.md`,
      `${REPORTS}\\sub\\sess-1.md`,
      `${REPORTS}\\sess-1.exe`,
      `${REPORTS}\\sess-1.md:evil`,
      REPORTS,
      '\\\\evil-host\\share\\sess-1.md',
      'reports\\sess-1.md',
      'C:\\Windows\\notes.md',
    ];
    for (const p of bad) {
      await expect(createSystemActions(d).openReport(p)).resolves.toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(d.realpath).not.toHaveBeenCalled();
    expect(d.openPath).not.toHaveBeenCalled();
  });

  it('refuses a report file that is a link to somewhere else, and says when it is missing', async () => {
    const linked = deps({ realpath: vi.fn((p: string) => Promise.resolve(p === REPORT ? 'C:\\elsewhere\\x.md' : p)) });
    await expect(createSystemActions(linked).openReport(REPORT)).resolves.toMatchObject({ ok: false, code: 'invalid' });
    const missing = deps({ isFile: vi.fn(() => Promise.resolve(false)) });
    await expect(createSystemActions(missing).openReport(REPORT)).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(linked.openPath).not.toHaveBeenCalled();
    expect(missing.openPath).not.toHaveBeenCalled();
  });

  it('copyText writes the text, and reports a clipboard failure instead of throwing', async () => {
    const d = deps();
    await expect(createSystemActions(d).copyText('an answer')).resolves.toEqual({ ok: true });
    expect(d.writeClipboard).toHaveBeenCalledWith('an answer');
    const broken = deps({ writeClipboard: vi.fn(() => Promise.reject(new Error('no'))) });
    await expect(createSystemActions(broken).copyText('x')).resolves.toMatchObject({ ok: false, code: 'failed' });
  });

  it('copies a report path to the clipboard and refuses text that is not one', async () => {
    const d = deps();
    await expect(createSystemActions(d).copyReportPath(REPORT)).resolves.toEqual({ ok: true, detail: REPORT });
    expect(d.writeClipboard).toHaveBeenCalledWith(REPORT);
    await expect(createSystemActions(d).copyReportPath('rm -rf /')).resolves.toMatchObject({ ok: false });
    // Copy has its own words; Open keeps its own.
    await expect(createSystemActions(d).copyReportPath('C:\\Windows\\notes.md')).resolves.toEqual({
      ok: false,
      code: 'invalid',
      message: "Huddle copies only the paths of report files it wrote, and this isn't one of them.",
    });
    await expect(createSystemActions(d).openReport('C:\\Windows\\notes.md')).resolves.toMatchObject({
      message: "Huddle opens only the report files it wrote, and this isn't one of them.",
    });
    expect(d.writeClipboard).toHaveBeenCalledTimes(1);
  });

  it('copies only a path inside the reports folder, checked before and after following links (nit)', async () => {
    const d = deps();
    for (const p of [`${REPORTS}\\..\\x.md`, `${REPORTS}\\sub\\sess-1.md`, 'C:\\Windows\\notes.md']) {
      await expect(createSystemActions(d).copyReportPath(p)).resolves.toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(d.realpath).not.toHaveBeenCalled();
    const linked = deps({ realpath: vi.fn((p: string) => Promise.resolve(p === REPORT ? 'C:\\elsewhere\\x.md' : p)) });
    await expect(createSystemActions(linked).copyReportPath(REPORT)).resolves.toMatchObject({
      ok: false,
      code: 'invalid',
    });
    const gone = deps({ realpath: vi.fn(() => Promise.reject(new Error('ENOENT'))) });
    await expect(createSystemActions(gone).copyReportPath(REPORT)).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(d.writeClipboard).not.toHaveBeenCalled();
    expect(linked.writeClipboard).not.toHaveBeenCalled();
    expect(gone.writeClipboard).not.toHaveBeenCalled();
  });
});
