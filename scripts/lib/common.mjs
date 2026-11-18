// Shared helpers for the developer scripts. Zero dependencies, Node 20+.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 47821;
export const HOOK_PATH_PREFIX = '/huddle/hooks/';
export const TOKEN_HEADER = 'x-huddle-token';
export const FORWARDER_FILENAME = 'huddle-forward-hook.mjs';

/** Claude Code's config directory: --config-dir, then CLAUDE_CONFIG_DIR, then ~/.claude. */
export function resolveConfigDir(explicit) {
  return path.resolve(explicit || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

/** Where Agent Huddle keeps its own files (config.json, the hook forwarder). */
export function huddleDir(configDir) {
  return path.join(configDir, 'agent-huddle');
}

/** 1-based line and column of a character offset. */
function lineColumn(text, offset) {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  return { line: before.split('\n').length, column: before.length - before.lastIndexOf('\n') };
}

/**
 * Where a JSON.parse failure is: "not valid JSON at line N, column M", or "not valid JSON". Only numbers are taken
 * from the error, because V8's message quotes the text around the mistake, which can be a token or an API key.
 * Same rules as describeJsonError in packages/core/src/setup/install-hooks.ts.
 */
export function describeJsonError(text, err) {
  const message = err instanceof Error ? err.message : '';
  const lc = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lc) return `not valid JSON at line ${lc[1]}, column ${lc[2]}`;
  const position = /at position (\d+)/.exec(message);
  const where = position ? lineColumn(text, Number(position[1])) : /end of (JSON|data)/i.test(message) ? lineColumn(text, text.length) : null;
  return where ? `not valid JSON at line ${where.line}, column ${where.column}` : 'not valid JSON';
}

/**
 * Read a JSON file without throwing. A parse error is described by line and column only (describeJsonError).
 * @returns {{exists: boolean, ok: boolean, value?: any, error?: string}}
 */
export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return { exists: false, ok: true, value: undefined };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    return { exists: true, ok: false, error: `unreadable (${err && err.code ? err.code : 'error'})` };
  }
  try {
    return { exists: true, ok: true, value: text.trim() === '' ? {} : JSON.parse(text) };
  } catch (err) {
    return { exists: true, ok: false, error: describeJsonError(text, err) };
  }
}

/**
 * Minimal argv parser: `--flag` booleans and `--key value` / `--key=value` options.
 * Unknown flags are reported instead of silently ignored.
 */
export function parseArgs(argv, { booleans = [], values = [] } = {}) {
  const out = { _: [], unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const eq = raw.indexOf('=');
    const key = (eq === -1 ? raw.slice(2) : raw.slice(2, eq)).trim();
    if (booleans.includes(key)) {
      out[key] = true;
    } else if (values.includes(key)) {
      const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
      if (value === undefined) out.unknown.push(`${raw} (missing value)`);
      else out[key] = value;
    } else {
      out.unknown.push(raw);
    }
  }
  return out;
}

/** Windows paths with forward slashes work in Git Bash, PowerShell and cmd alike. */
export function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * The first character that makes a path unsafe inside `node "<path>"`: Git Bash and PowerShell expand `$` and a
 * backtick inside double quotes, `"` ends the quoting and cmd expands `%`. No single quoting works in all three
 * shells, so the installers refuse such a path. Same rule as shellUnsafePathChar in packages/core/src/setup/install-hooks.ts.
 */
export function shellUnsafePathChar(p) {
  const m = /[$`"%]/.exec(p);
  return m ? m[0] : null;
}
