#!/usr/bin/env node
/**
 * Agent Huddle — status line bridge (F9, ADR-018).
 *
 * Claude Code runs ONE status line command and pipes it a JSON object on stdin (docs/INTEGRATION.md "Status line
 * data"). The installer (opt-in) points `statusLine` at this script and saves the user's own `statusLine` in
 * <claude config dir>/agent-huddle/statusline-original.json. This script then:
 *   1. reads the JSON from stdin;
 *   2. fires a POST of it to the local Huddle (127.0.0.1, X-Huddle-Token from agent-huddle/config.json), with a short
 *      timeout, and does NOT wait for it before step 3;
 *   3. runs the user's ORIGINAL command with the same stdin, through the shell Claude Code would use (Windows: Git Bash
 *      if installed, else PowerShell; elsewhere $SHELL or /bin/sh), and passes its stdout, stderr and exit code
 *      through unchanged. With no original line it prints nothing and exits 0.
 *
 * Contract: it must never change what the user sees. The Huddle being down, slow or answering an error makes no
 * output and no error text. Claude Code debounces refreshes at 300 ms and cancels a running script on a new trigger,
 * so the POST is capped at POST_TIMEOUT_MS and the exit waits for it at most that long.
 *
 * Self-contained, zero dependencies: the installer copies this single file into <claude config dir>/agent-huddle/.
 * Config and the saved original come only from the Claude config directory, never from next to this script.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const POST_TIMEOUT_MS = 250;
export const STATUSLINE_PATH = '/huddle/statusline';
const DEFAULT_PORT = 47821;
/** Never run ourselves as "the original" (that would recurse). */
const SELF = /huddle-statusline\.mjs/i;

export function defaultConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}

/** {port, token} from agent-huddle/config.json (written by the installer), or {} when missing. */
export function loadConfig(configDir) {
  const value = readJson(path.join(configDir, 'agent-huddle', 'config.json'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** The user's original command, or null (no saved line, not a command, or our own wrapper). */
export function loadOriginalCommand(configDir) {
  const saved = readJson(path.join(configDir, 'agent-huddle', 'statusline-original.json'));
  const line = saved && typeof saved === 'object' ? saved.statusLine : null;
  if (!line || typeof line !== 'object' || line.type !== 'command') return null;
  if (typeof line.command !== 'string' || line.command.trim() === '' || SELF.test(line.command)) return null;
  return line.command;
}

/**
 * The shell Claude Code uses for a status line command (INTEGRATION.md: "On Windows: Git Bash if installed, otherwise
 * PowerShell"). Git Bash is found the way it is usually installed: CLAUDE_CODE_GIT_BASH_PATH, a Git folder on PATH,
 * or Program Files. System32\bash.exe (WSL) is never used.
 *
 * The shell binary is always a fully qualified path. The bridge runs in the session's working folder (Claude Code's
 * cwd, which the user's command keeps), so a bare `powershell.exe` or a relative PATH entry could start an executable
 * planted in the project folder. Relative PATH entries and candidates are skipped; PowerShell is named by its full
 * path under %SystemRoot%.
 */
export function resolveShell({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') {
    const shell = env.SHELL && path.posix.isAbsolute(env.SHELL) ? env.SHELL : '/bin/sh';
    return { file: shell, args: (command) => ['-c', command] };
  }
  const found = (file) => isFullWindowsPath(file) && exists(file);
  const bash = (file) => ({ file, args: (command) => ['-c', command] });
  const pinned = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (found(pinned)) return bash(pinned);
  const dirs = (env.PATH || env.Path || '').split(';').filter(isFullWindowsPath);
  for (const dir of dirs) {
    if (/git/i.test(dir) && found(path.win32.join(dir, 'bash.exe'))) return bash(path.win32.join(dir, 'bash.exe'));
    if (found(path.win32.join(dir, 'git.exe'))) {
      for (const rel of ['..\\bin\\bash.exe', '..\\usr\\bin\\bash.exe']) {
        const candidate = path.win32.resolve(dir, rel);
        if (found(candidate)) return bash(candidate);
      }
    }
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Programs`]) {
    if (!isFullWindowsPath(root)) continue;
    const candidate = path.win32.join(root, 'Git', 'bin', 'bash.exe');
    if (found(candidate)) return bash(candidate);
  }
  return {
    file: windowsPowerShell(env),
    args: (command) => ['-NoProfile', '-NonInteractive', '-Command', command],
  };
}

/**
 * True for a drive-qualified (`C:\...`) or UNC (`\\server\...`) path. `path.win32.isAbsolute` alone also accepts
 * `\foo`, which resolves against the current drive, so it is not enough here.
 */
export function isFullWindowsPath(value) {
  return typeof value === 'string' && path.win32.isAbsolute(value) && /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(value);
}

/** Full path of Windows PowerShell 5.1; never the bare name (which would search the current folder first). */
export function windowsPowerShell(env = process.env) {
  const root = [env.SystemRoot, env.SYSTEMROOT, env.windir].find(isFullWindowsPath) ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** POSTs the body to the Huddle. Resolves (never rejects) when it is answered, fails or times out. */
export function postToHuddle(body, config, { timeoutMs = POST_TIMEOUT_MS, request = http.request } = {}) {
  return new Promise((resolve) => {
    if (typeof config.token !== 'string' || config.token === '') return resolve('no-token');
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let req;
    const timer = setTimeout(() => {
      req?.destroy();
      finish('timeout');
    }, timeoutMs);
    try {
      req = request(
        {
          host: '127.0.0.1',
          port: Number(config.port) || DEFAULT_PORT,
          path: STATUSLINE_PATH,
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            'x-huddle-token': config.token,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => finish(res.statusCode ?? 0));
          res.on('error', () => finish('error'));
        },
      );
      req.on('error', () => finish('error'));
      req.end(body);
    } catch {
      finish('error');
    }
  });
}

/**
 * Runs the original command with `input` on stdin; its stdout and stderr go straight to ours. Resolves with its exit
 * code (1 when it was killed or could not start; Claude Code shows nothing for a non-zero exit either way).
 */
export function runOriginal(command, input, { shell = resolveShell(), spawnFn = spawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(shell.file, shell.args(command), {
        stdio: ['pipe', 'inherit', 'inherit'],
        env,
        windowsHide: true,
      });
    } catch {
      return resolve(1);
    }
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 1));
    child.stdin?.on('error', () => undefined); // the command may not read stdin (EPIPE)
    child.stdin?.end(input);
  });
}

/** Reads all of stdin. A terminal (someone ran the script by hand) counts as empty input. */
export function readAll(stream) {
  return new Promise((resolve) => {
    if (stream.isTTY) return resolve(Buffer.alloc(0));
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * The whole bridge, with its edges injectable for tests. Resolves with the exit code to use.
 * The POST starts first and the original runs right away, without waiting for it.
 */
export async function main({
  stdin = process.stdin,
  configDir = defaultConfigDir(),
  post = postToHuddle,
  run = runOriginal,
  postTimeoutMs = POST_TIMEOUT_MS,
} = {}) {
  const input = await readAll(stdin);
  const config = loadConfig(configDir);
  const command = loadOriginalCommand(configDir);
  let sent = Promise.resolve();
  if (input.length > 0) {
    try {
      sent = Promise.resolve(post(input, config)).catch(() => undefined);
    } catch {
      // never let the Huddle side change the user's line
    }
  }
  const code = command === null ? 0 : await run(command, input).catch(() => 1);
  // Give the POST its remaining time, never more: the exit must not wait on a slow Huddle.
  let cap;
  await Promise.race([sent, new Promise((resolve) => (cap = setTimeout(resolve, postTimeoutMs)))]);
  clearTimeout(cap);
  return code;
}

/**
 * Is this file the script node was started with? Real paths are compared, so a config folder reached through a junction
 * or symlink still counts (import.meta.url is the real path, argv[1] is the path as typed). A copy lives in each
 * script because they ship standalone.
 */
function isEntryPoint() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const self = fileURLToPath(import.meta.url);
  let a;
  let s;
  try {
    a = fs.realpathSync(argv1);
    s = fs.realpathSync(self);
  } catch {
    a = path.resolve(argv1);
    s = self;
  }
  return norm(a) === norm(s);
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 0;
    },
  );
}
