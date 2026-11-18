/**
 * Which processes are running, and with what command line (M4 follow-up: start-up reconciliation of orphaned runs).
 * An I/O edge; the parsers are pure and exported for tests.
 *
 * Windows: `Get-CimInstance Win32_Process -Filter "ProcessId=<a> OR ProcessId=<b>"` through
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <script>`, spawned
 * with an args array and no shell. The pids are checked integers before they go into the filter, so nothing else can
 * reach the script. If PowerShell fails, `%SystemRoot%\System32\wbem\wmic.exe process where ProcessId=<pid> get
 * ProcessId,CommandLine /format:list` per pid (wmic is deprecated and missing on newer Windows 11 builds).
 * Elsewhere: `ps -o pid=,args= -p <a>,<b>`.
 *
 * The answer: a map pid -> command line for every pid that is running (null command line: running, but its command
 * line could not be read, e.g. another user's or an elevated process), with pids that are not running left out; or
 * null when the list could not be read at all. Callers treat null and a null command line as "cannot be verified".
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

export type CommandLines = ReadonlyMap<number, string | null>;
/** Resolves null when the process list could not be read. Never rejects. */
export type CommandLineReader = (pids: readonly number[]) => Promise<CommandLines | null>;

/** How long one query may take before it counts as failed. */
export const PROCESS_QUERY_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

function validPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff;
}

interface ExecOutcome {
  ok: boolean;
  code: number | null;
  stdout: string;
}

function run(command: string, args: readonly string[]): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { windowsHide: true, shell: false, timeout: PROCESS_QUERY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
      (error, stdout) => {
        if (error === null) {
          resolve({ ok: true, code: 0, stdout });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : null;
        resolve({ ok: false, code, stdout: typeof stdout === 'string' ? stdout : '' });
      },
    );
  });
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? 'C:\\Windows';
  // Only a plain local drive path is used; anything else falls back to the default location.
  return /^[A-Za-z]:\\[^"*?<>|]*$/.test(root) ? root : 'C:\\Windows';
}

/** The PowerShell script for these pids (already checked). Always prints a JSON array. */
export function powerShellScript(pids: readonly number[]): string {
  const filter = pids.map((p) => `ProcessId=${String(p)}`).join(' OR ');
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$p = @(Get-CimInstance -ClassName Win32_Process -Filter '${filter}' | Select-Object ProcessId, CommandLine)`,
    'ConvertTo-Json -InputObject $p -Compress',
  ].join('; ');
}

/** Pure: PowerShell's JSON (an array, or one object) to pid -> command line. Null when it is not that shape. */
export function parsePowerShellProcesses(text: string): Map<number, string | null> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed);
  } catch {
    return null;
  }
  const items = Array.isArray(raw) ? raw : [raw];
  const out = new Map<number, string | null>();
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return null;
    const rec = item as Record<string, unknown>;
    const pid = rec.ProcessId;
    if (typeof pid !== 'number' || !validPid(pid)) return null;
    const line = rec.CommandLine;
    out.set(pid, typeof line === 'string' && line !== '' ? line : null);
  }
  return out;
}

/**
 * Pure: `wmic ... get ProcessId,CommandLine /format:list` output to pid -> command line ("No Instance(s) Available."
 * or nothing: an empty map). Lines end in CR CR LF.
 */
export function parseWmicList(text: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  let line: string | null = null;
  let pid: number | null = null;
  const flush = () => {
    if (pid !== null && validPid(pid)) out.set(pid, line !== null && line !== '' ? line : null);
    line = null;
    pid = null;
  };
  for (const raw of text.split(/\r*\n/)) {
    const row = raw.replace(/\r+$/, '');
    if (row.trim() === '') {
      if (pid !== null) flush();
      continue;
    }
    if (row.startsWith('CommandLine=')) line = row.slice('CommandLine='.length).trim();
    else if (row.startsWith('ProcessId=')) pid = Number(row.slice('ProcessId='.length).trim());
  }
  flush();
  return out;
}

/** Pure: `ps -o pid=,args=` output to pid -> command line. */
export function parsePsList(text: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  for (const row of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(row);
    if (m === null) continue;
    const pid = Number(m[1]);
    if (validPid(pid)) out.set(pid, (m[2] ?? '').trim() || null);
  }
  return out;
}

async function windowsCommandLines(pids: readonly number[], env: NodeJS.ProcessEnv): Promise<CommandLines | null> {
  const root = systemRoot(env);
  const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const ps = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', powerShellScript(pids)]);
  if (ps.ok) {
    const parsed = parsePowerShellProcesses(ps.stdout);
    if (parsed !== null) return parsed;
  }
  // Fallback: wmic, one pid at a time.
  const wmic = path.win32.join(root, 'System32', 'wbem', 'wmic.exe');
  const out = new Map<number, string | null>();
  for (const pid of pids) {
    const r = await run(wmic, [
      'process',
      'where',
      `ProcessId=${String(pid)}`,
      'get',
      'ProcessId,CommandLine',
      '/format:list',
    ]);
    if (!r.ok) return null;
    for (const [p, line] of parseWmicList(r.stdout)) out.set(p, line);
  }
  return out;
}

async function posixCommandLines(pids: readonly number[]): Promise<CommandLines | null> {
  const r = await run('ps', ['-o', 'pid=,args=', '-p', pids.join(',')]);
  // ps exits 1 when none of the pids is running.
  if (!r.ok && !(r.code === 1 && r.stdout.trim() === '')) return null;
  return parsePsList(r.stdout);
}

/** The default CommandLineReader (see the file comment). Invalid pids are left out of the answer. Never rejects. */
export async function readProcessCommandLines(
  pids: readonly number[],
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<CommandLines | null> {
  const wanted = [...new Set(pids.filter(validPid))];
  if (wanted.length === 0) return new Map();
  try {
    return (options.platform ?? process.platform) === 'win32'
      ? await windowsCommandLines(wanted, options.env ?? process.env)
      : await posixCommandLines(wanted);
  } catch {
    return null;
  }
}
