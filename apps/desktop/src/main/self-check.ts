/**
 * Spike S23 build self-check (`--huddle-self-check=<file>.json`, launch-mode.ts). Answers, from inside the built app:
 *  (a) does `node:sqlite` open a database in this Electron's main process (memory and a temp file);
 *  (b) are the files an external `node` must run (forwarder, status line bridge, MCP server) and the phone page real
 *      files outside app.asar;
 *  (c, d) what a PATH lookup finds for `node` and `claude` in the env this process got (Start menu vs terminal).
 * Starts no core, opens no window, never writes under the Claude config folder; the one file written is the report
 * (and a scratch database in the OS temp folder, removed again). Only counts and paths go into the report, never env
 * values.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudePathEntries, resolveClaudeExecutable } from '@huddle/core';
import { shippedFiles, type CoreEnv } from './core-config.js';

export interface SelfCheckEnv extends CoreEnv {
  versions: NodeJS.ProcessVersions;
  platform: NodeJS.Platform;
  appUserModelId: string;
  /** app.getLoginItemSettings(), read only. */
  loginItem: unknown;
}

interface FileFact {
  path: string;
  kind: 'file' | 'dir' | 'missing';
  insideAsar: boolean;
}

async function fact(p: string): Promise<FileFact> {
  const insideAsar = p.split(/[\\/]/).some((part) => part.toLowerCase().endsWith('.asar'));
  try {
    const s = await fsp.stat(p);
    return { path: p, kind: s.isDirectory() ? 'dir' : 'file', insideAsar };
  } catch {
    return { path: p, kind: 'missing', insideAsar };
  }
}

async function sqliteCheck(): Promise<Record<string, unknown>> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const mem = new DatabaseSync(':memory:');
    const row = mem.prepare('select sqlite_version() as v').get() as { v?: unknown } | undefined;
    mem.close();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-s23-'));
    const file = path.join(dir, 'check.db');
    try {
      const db = new DatabaseSync(file);
      db.exec('create table t (x integer); insert into t values (42);');
      const back = db.prepare('select x from t').get() as { x?: unknown } | undefined;
      db.close();
      return { ok: true, sqliteVersion: row?.v ?? null, fileRoundTrip: back?.x === 42 };
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function nodeOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | null> {
  const name = platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of claudePathEntries(env, platform)) {
    const candidate = path.join(dir, name);
    if ((await fact(candidate)).kind === 'file') return candidate;
  }
  return null;
}

export async function selfCheckReport(e: SelfCheckEnv): Promise<Record<string, unknown>> {
  const files = shippedFiles(e);
  const env = e.env as NodeJS.ProcessEnv;
  const claude = await resolveClaudeExecutable({ env, platform: e.platform });
  return {
    check: 'S23 self-check',
    packaged: e.packaged,
    versions: { electron: e.versions.electron, node: e.versions.node, chrome: e.versions.chrome },
    paths: {
      execPath: e.execPath,
      appPath: e.appPath,
      resourcesPath: e.resourcesPath,
      userData: e.userData,
    },
    appUserModelId: e.appUserModelId,
    sqlite: await sqliteCheck(),
    shipped: {
      forwarder: await fact(files.forwarder),
      statusline: await fact(files.statusline),
      mcpServer: await fact(files.mcpServer),
      phoneDir: await fact(files.phoneDir),
      phoneIndex: await fact(path.join(files.phoneDir, 'index.html')),
      icon: await fact(files.icon),
    },
    pathLookup: {
      pathEntries: claudePathEntries(env, e.platform).length,
      node: await nodeOnPath(env, e.platform),
      claude: claude.ok ? { ok: true, path: claude.path } : { ok: false, reason: claude.reason },
    },
    loginItem: e.loginItem,
  };
}
