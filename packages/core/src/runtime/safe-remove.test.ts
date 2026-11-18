import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newestFileMtimeNoFollow, removeTreeNoFollow } from './safe-remove.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-safe-remove-'));
  roots.push(root);
  return root;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

describe('removeTreeNoFollow', () => {
  it('removes a nested tree with files and folders', async () => {
    const root = await tempRoot();
    const tree = path.join(root, 'events.migrated-2026-11-14');
    await fsp.mkdir(path.join(tree, 'a', 'b'), { recursive: true });
    await fsp.writeFile(path.join(tree, 'one.jsonl'), 'x\n');
    await fsp.writeFile(path.join(tree, 'a', 'b', 'two.jsonl'), 'y\n');
    const readOnly = path.join(tree, 'a', 'ro.jsonl');
    await fsp.writeFile(readOnly, 'z\n');
    await fsp.chmod(readOnly, 0o444);
    const result = await removeTreeNoFollow(tree);
    expect(result).toMatchObject({ existed: true, files: 3, folders: 3, links: 0 });
    expect(await exists(tree)).toBe(false);
  });

  it('is a no-op for a missing folder', async () => {
    const root = await tempRoot();
    expect(await removeTreeNoFollow(path.join(root, 'nope'))).toEqual({
      existed: false,
      files: 0,
      folders: 0,
      links: 0,
    });
  });

  it('removes a junction (Windows) or directory symlink as a link and never deletes what it points to', async () => {
    const root = await tempRoot();
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'precious.txt'), 'keep me');
    const tree = path.join(root, 'events');
    await fsp.mkdir(tree);
    await fsp.writeFile(path.join(tree, 's.jsonl'), '{}\n');
    // A junction needs no privilege on Windows; elsewhere a plain directory symlink.
    await fsp.symlink(outside, path.join(tree, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await removeTreeNoFollow(tree);
    expect(result.links).toBe(1);
    expect(await exists(tree)).toBe(false);
    expect(await fsp.readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
  });

  it('removes a target that is itself a link without touching its target', async () => {
    const root = await tempRoot();
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'precious.txt'), 'keep me');
    const link = path.join(root, 'events');
    await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await removeTreeNoFollow(link);
    expect(result).toMatchObject({ existed: true, links: 1, files: 0 });
    expect(await exists(link)).toBe(false);
    expect(await exists(path.join(outside, 'precious.txt'))).toBe(true);
  });
});

describe('newestFileMtimeNoFollow (M1)', () => {
  it('is the newest file time in the tree, folders not counted, links not entered', async () => {
    const root = await tempRoot();
    const tree = path.join(root, 'events.migrated-2026-10-01');
    await fsp.mkdir(path.join(tree, 'a'), { recursive: true });
    const t1 = Date.parse('2026-09-01T00:00:00Z');
    const t2 = Date.parse('2026-09-15T00:00:00Z');
    await fsp.writeFile(path.join(tree, 'one.jsonl'), 'x\n');
    await fsp.writeFile(path.join(tree, 'a', 'two.jsonl'), 'y\n');
    await fsp.utimes(path.join(tree, 'one.jsonl'), t1 / 1000, t1 / 1000);
    await fsp.utimes(path.join(tree, 'a', 'two.jsonl'), t2 / 1000, t2 / 1000);
    expect(await newestFileMtimeNoFollow(tree)).toBe(t2);

    // A junction to a folder with a newer file: the link's own time counts, the target's file is never looked at.
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'future.txt'), 'f');
    const future = Date.parse('2030-01-01T00:00:00Z');
    await fsp.utimes(path.join(outside, 'future.txt'), future / 1000, future / 1000);
    await fsp.symlink(outside, path.join(tree, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const withLink = await newestFileMtimeNoFollow(tree);
    expect(withLink).toBeLessThan(future);
    expect(withLink).toBe((await fsp.lstat(path.join(tree, 'link'))).mtimeMs);

    expect(await newestFileMtimeNoFollow(path.join(root, 'missing'))).toBe(Number.NEGATIVE_INFINITY);
    const empty = path.join(root, 'empty');
    await fsp.mkdir(empty);
    expect(await newestFileMtimeNoFollow(empty)).toBe(Number.NEGATIVE_INFINITY);
  });
});
