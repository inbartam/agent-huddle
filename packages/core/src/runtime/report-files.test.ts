/**
 * The run reports' file writer (M5, F23): two writes of one report at once never fail (on Windows the second rename
 * over the same file failed with EPERM about 1 in 10 pairs before `ReportFileWriter`), waiting requests coalesce into
 * one write with the newest content, a briefly locked target is retried, and no temp file is ever left behind.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RENAME_RETRIES,
  ReportFileWriter,
  reportPathFor,
  reportsDirOf,
  writeReportFile,
  type ReportFileOps,
} from './report-files.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function dataDir(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-report-files-'));
  roots.push(root);
  return root;
}

async function tempFiles(dir: string): Promise<string[]> {
  return (await fsp.readdir(reportsDirOf(dir))).filter((n) => n.endsWith('.tmp'));
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename`), { code, syscall: 'rename' });
}

/** A rename that waits for `open()` before it does anything; counts the calls. */
function gatedRename(): { ops: ReportFileOps; calls: string[]; open: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  return {
    calls,
    open: () => {
      release();
    },
    ops: {
      rename: async (from, to) => {
        calls.push(path.basename(to));
        await gate;
        await fsp.rename(from, to);
      },
    },
  };
}

describe('ReportFileWriter: concurrent writes of one report', () => {
  it('200 rounds of two writes at once: every write succeeds, the newest content wins, no temp file left', async () => {
    const dir = await dataDir();
    const writer = new ReportFileWriter(dir);
    const file = reportPathFor(dir, 'sess-race');
    const failures: string[] = [];
    for (let round = 0; round < 200; round++) {
      const a = `a ${String(round)}\n`.repeat(2000);
      const b = `b ${String(round)}\n`.repeat(2000);
      const results = await Promise.allSettled([writer.write('sess-race', a), writer.write('sess-race', b)]);
      for (const r of results) {
        if (r.status === 'rejected') failures.push(String((r.reason as NodeJS.ErrnoException).code));
        else expect(r.value).toBe(file);
      }
      expect(await fsp.readFile(file ?? '', 'utf8')).toBe(b);
    }
    expect(failures).toEqual([]);
    expect(await tempFiles(dir)).toEqual([]);
    // ~1 s alone, but 400 real file writes passed Vitest's 5 s default when the whole suite runs in parallel on Windows
    // (a timeout, never a wrong result); the limit is about load, not about the writer.
  }, 30_000);

  it('coalesces the requests that wait behind a write in flight into one write with the newest content', async () => {
    const dir = await dataDir();
    const gate = gatedRename();
    const writer = new ReportFileWriter(dir, gate.ops);
    const first = writer.write('s1', 'one');
    // Let the first write reach its rename (mkdir and writeFile happen before it).
    await expect.poll(() => gate.calls.length).toBe(1);
    const waiting = [writer.write('s1', 'two'), writer.write('s1', 'three'), writer.write('s1', 'four')];
    gate.open();
    const file = reportPathFor(dir, 's1');
    await expect(first).resolves.toBe(file);
    await expect(Promise.all(waiting)).resolves.toEqual([file, file, file]);
    expect(gate.calls).toEqual(['s1.md', 's1.md']);
    expect(await fsp.readFile(file ?? '', 'utf8')).toBe('four');
    await writer.idle();
    expect(await tempFiles(dir)).toEqual([]);
  });

  it('writes different sessions in parallel', async () => {
    const dir = await dataDir();
    const gate = gatedRename();
    const writer = new ReportFileWriter(dir, gate.ops);
    const both = Promise.all([writer.write('s1', 'x'), writer.write('s2', 'y')]);
    // Both renames start before either finishes: no session waits for another.
    await expect.poll(() => [...gate.calls].sort()).toEqual(['s1.md', 's2.md']);
    gate.open();
    await expect(both).resolves.toEqual([reportPathFor(dir, 's1'), reportPathFor(dir, 's2')]);
  });

  it('rejects every request that shared a failed write; the next request writes again', async () => {
    const dir = await dataDir();
    let fail = true;
    const writer = new ReportFileWriter(dir, {
      rename: async (from, to) => {
        if (fail) throw errno('ENOSPC');
        await fsp.rename(from, to);
      },
    });
    const results = await Promise.allSettled([writer.write('s1', 'a'), writer.write('s1', 'b')]);
    expect(results.map((r) => (r.status === 'rejected' ? (r.reason as NodeJS.ErrnoException).code : 'ok'))).toEqual([
      'ENOSPC',
      'ENOSPC',
    ]);
    expect(await tempFiles(dir)).toEqual([]);
    fail = false;
    await expect(writer.write('s1', 'c')).resolves.toBe(reportPathFor(dir, 's1'));
    expect(await fsp.readFile(reportPathFor(dir, 's1') ?? '', 'utf8')).toBe('c');
  });

  it('writes nothing for a session marked deleted, until its mark is cleared', async () => {
    const dir = await dataDir();
    const gate = gatedRename();
    gate.open();
    const writer = new ReportFileWriter(dir, gate.ops);
    writer.refuse(['gone', 'also-gone']);
    expect(writer.isRefused('gone')).toBe(true);
    await expect(writer.write('gone', 'text')).resolves.toBeNull();
    expect(gate.calls).toEqual([]);
    await expect(fsp.access(reportPathFor(dir, 'gone') ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
    // Other sessions are not affected.
    await expect(writer.write('other', 'x')).resolves.toBe(reportPathFor(dir, 'other'));
    writer.allow('gone');
    await expect(writer.write('gone', 'back')).resolves.toBe(reportPathFor(dir, 'gone'));
    expect(await fsp.readFile(reportPathFor(dir, 'gone') ?? '', 'utf8')).toBe('back');
    await expect(writer.write('also-gone', 'text')).resolves.toBeNull();
  });

  it('a write queued behind the one in flight is dropped when its session is marked meanwhile', async () => {
    const dir = await dataDir();
    const gate = gatedRename();
    const writer = new ReportFileWriter(dir, gate.ops);
    const inFlight = writer.write('s1', 'first');
    await expect.poll(() => gate.calls.length).toBe(1);
    const queued = writer.write('s1', 'second');
    writer.refuse(['s1']);
    let idle = false;
    const done = writer.idle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The write already past the check finishes (the deletion waits for it, then removes the file).
    expect(idle).toBe(false);
    gate.open();
    await expect(inFlight).resolves.toBe(reportPathFor(dir, 's1'));
    await expect(queued).resolves.toBeNull();
    await done;
    expect(gate.calls).toEqual(['s1.md']);
    expect(await fsp.readFile(reportPathFor(dir, 's1') ?? '', 'utf8')).toBe('first');
    expect(await tempFiles(dir)).toEqual([]);
  });

  it('idle() waits for the writes in flight, including ones queued behind them', async () => {
    const dir = await dataDir();
    const gate = gatedRename();
    const writer = new ReportFileWriter(dir, gate.ops);
    void writer.write('s1', 'one');
    await expect.poll(() => gate.calls.length).toBe(1);
    void writer.write('s1', 'two');
    let idle = false;
    const done = writer.idle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(idle).toBe(false);
    gate.open();
    await done;
    expect(await fsp.readFile(reportPathFor(dir, 's1') ?? '', 'utf8')).toBe('two');
  });
});

describe('writeReportFile: the rename over the old file', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    it(`retries ${code} with a short, growing wait and then succeeds`, async () => {
      const dir = await dataDir();
      const waits: number[] = [];
      let failures = 2;
      const file = await writeReportFile(dir, 's1', 'text', {
        rename: async (from, to) => {
          if (failures-- > 0) throw errno(code);
          await fsp.rename(from, to);
        },
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      });
      expect(await fsp.readFile(file, 'utf8')).toBe('text');
      expect(waits).toEqual([25, 50]);
      expect(await tempFiles(dir)).toEqual([]);
    });
  }

  it(`gives up after ${String(RENAME_RETRIES)} retries, rejects with the last error and removes the temp file`, async () => {
    const dir = await dataDir();
    let attempts = 0;
    const waits: number[] = [];
    const write = writeReportFile(dir, 's1', 'text', {
      rename: () => {
        attempts += 1;
        return Promise.reject(errno('EBUSY'));
      },
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await expect(write).rejects.toMatchObject({ code: 'EBUSY' });
    expect(attempts).toBe(RENAME_RETRIES + 1);
    expect(waits).toEqual([25, 50, 75, 100]);
    expect(await tempFiles(dir)).toEqual([]);
    expect(await fsp.readdir(reportsDirOf(dir))).toEqual([]);
  });

  it('does not retry an error that waiting will not fix', async () => {
    const dir = await dataDir();
    let attempts = 0;
    const write = writeReportFile(dir, 's1', 'text', {
      rename: () => {
        attempts += 1;
        return Promise.reject(errno('EXDEV'));
      },
      sleep: () => Promise.resolve(),
    });
    await expect(write).rejects.toMatchObject({ code: 'EXDEV' });
    expect(attempts).toBe(1);
    expect(await tempFiles(dir)).toEqual([]);
  });

  it('refuses a session id the store would not accept, before touching the disk', async () => {
    const dir = await dataDir();
    await expect(writeReportFile(dir, '../x', 'text')).rejects.toThrow('invalid session id');
    await expect(fsp.access(reportsDirOf(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
