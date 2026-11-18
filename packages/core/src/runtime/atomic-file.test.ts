import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeHuddleSettings, parseHuddleSettings } from './huddle-settings.js';
import { writeTextAtomic } from './atomic-file.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

async function tmpDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-atomic-'));
  dirs.push(d);
  return d;
}

/** A temp write that fails half way: the temp file exists (partly written) and the write rejects, as on a full disk. */
function failingTempWrite(): void {
  const realWrite = fsp.writeFile.bind(fsp);
  vi.spyOn(fsp, 'writeFile').mockImplementation((async (file: string) => {
    await realWrite(file, 'partial');
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  }) as unknown as typeof fsp.writeFile);
}

describe('atomic writes remove the temp file when the temp write fails', () => {
  it('writeTextAtomic', async () => {
    const dir = await tmpDir();
    failingTempWrite();
    await expect(writeTextAtomic(path.join(dir, 'rules.json'), '[]')).rejects.toThrow('no space left');
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('writeHuddleSettings', async () => {
    const dir = await tmpDir();
    failingTempWrite();
    await expect(writeHuddleSettings(dir, parseHuddleSettings(null))).rejects.toThrow('no space left');
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});
