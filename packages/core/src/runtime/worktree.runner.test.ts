/** createGitRunner with a stand-in execFile: how git is spawned, without running it. */
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as { file: string; options: { cwd?: string } }[]);

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    _args: string[],
    options: { cwd?: string },
    done: (error: null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ file, options });
    done(null, '', '');
  },
}));

const { createGitRunner } = await import('./worktree.js');

describe('createGitRunner (A2-04)', () => {
  it('spawns git with a neutral working folder, never the process cwd (Windows searches it before PATH)', async () => {
    const result = await createGitRunner()(['-C', 'C:/repo', 'status']);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.cwd).toBe(os.tmpdir());
  });
});
