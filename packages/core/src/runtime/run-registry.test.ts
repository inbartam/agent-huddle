/** runs.json: parse (unknown fields kept, bad entries kept unread), atomic add/remove in order, a corrupt file kept aside. */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRunRegistry, RunRegistry, runRegistryPath, serializeRunRegistry } from './run-registry.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-runs-'));
  dirs.push(d);
  return d;
}

describe('parseRunRegistry', () => {
  it('keeps unknown fields and entries it cannot read; a second entry for a run is not used', () => {
    const text = JSON.stringify({
      version: 1,
      writtenBy: 'a newer build',
      runs: [
        { runId: A, pid: 10, startedAt: 5, command: 'C:\\c.exe', extra: { x: 1 } },
        { runId: 'not-a-uuid', pid: 11, startedAt: 5, command: 'c' },
        { runId: B, pid: -1, startedAt: 5, command: 'c' },
        { runId: A.toUpperCase(), pid: 12, startedAt: 6, command: 'c' },
      ],
    });
    const file = parseRunRegistry(text);
    expect(file.corrupt).toBe(false);
    expect(file.entries).toEqual([{ runId: A, pid: 10, startedAt: 5, command: 'C:\\c.exe', extra: { x: 1 } }]);
    expect(file.invalid).toHaveLength(3);
    expect(file.extra).toEqual({ writtenBy: 'a newer build' });
    const again = JSON.parse(serializeRunRegistry(file)) as { runs: unknown[]; writtenBy: string; version: number };
    expect(again.version).toBe(1);
    expect(again.writtenBy).toBe('a newer build');
    expect(again.runs).toHaveLength(4);
  });

  it('missing, not JSON, wrong shape, BOM', () => {
    expect(parseRunRegistry(null)).toEqual({ entries: [], invalid: [], extra: {}, corrupt: false });
    expect(parseRunRegistry('{"runs":').corrupt).toBe(true);
    expect(parseRunRegistry('[]').corrupt).toBe(true);
    expect(parseRunRegistry('{"version":1}').corrupt).toBe(true);
    expect(parseRunRegistry(`\ufeff{"version":1,"runs":[]}`).corrupt).toBe(false);
  });
});

describe('RunRegistry', () => {
  it('add then remove, in the order asked, each written whole', async () => {
    const dir = await tempDir();
    const reg = new RunRegistry({ dataDir: dir, now: () => 7 });
    expect((await reg.read()).entries).toEqual([]);
    const adds = [
      reg.add({ runId: A, pid: 10, startedAt: 1, command: 'a' }),
      reg.add({ runId: B, pid: 20, startedAt: 2, command: 'b' }),
      reg.remove([A]),
    ];
    await Promise.all(adds);
    expect((await reg.read()).entries.map((e) => e.runId)).toEqual([B]);
    // Same run again replaces its entry.
    await reg.add({ runId: B, pid: 21, startedAt: 3, command: 'b' });
    expect((await reg.read()).entries).toEqual([{ runId: B, pid: 21, startedAt: 3, command: 'b' }]);
    await reg.remove([B, A]);
    expect((await reg.read()).entries).toEqual([]);
    // No temp files left behind.
    expect((await fsp.readdir(dir)).sort()).toEqual(['runs.json']);
  });

  it('a corrupt file is moved aside before the next write, never overwritten', async () => {
    const dir = await tempDir();
    await fsp.writeFile(runRegistryPath(dir), '{"runs": [ oops');
    const reg = new RunRegistry({ dataDir: dir, now: () => 42 });
    expect((await reg.read()).corrupt).toBe(true);
    await reg.add({ runId: A, pid: 10, startedAt: 1, command: 'a' });
    expect(await fsp.readFile(path.join(dir, 'runs.json.bad-42'), 'utf8')).toBe('{"runs": [ oops');
    expect((await reg.read()).entries.map((e) => e.runId)).toEqual([A]);
  });

  it('remove with nothing to remove and no file writes nothing', async () => {
    const dir = await tempDir();
    await new RunRegistry({ dataDir: dir, now: () => 1 }).remove([A]);
    expect(await fsp.readdir(dir)).toEqual([]);
  });
});
