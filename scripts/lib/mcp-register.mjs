// The opt-in self-report registration step of the M0 installer script (M6 P4, F27, ADR-025). Zero dependencies.
// Same rules as packages/core/src/setup/mcp-register.ts (the app's path):
//   - the Huddle never writes .claude.json; `claude mcp add|remove --scope user huddle` does, run as an argv array
//     (no shell), after the user saw the exact command (dry run by default, --apply to run);
//   - a `huddle` server that is not the Huddle's is never replaced or removed;
//   - the file is read again after the command and the result checked.
// .claude.json: <CLAUDE_CONFIG_DIR>/.claude.json when the variable names the config dir, ~/.claude.json for the
// default ~/.claude (the variable is then NOT set for the child: that would move the file), otherwise the variable is
// set to the config dir for the child (tests, --config-dir).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MCP_SERVER_KEY = 'huddle';
export const MCP_FILENAME = 'huddle-mcp.mjs';

const toPosix = (p) => p.replace(/\\/g, '/');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function samePath(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function envValue(env, name) {
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === name) return v;
  return undefined;
}

function withoutVar(env, name) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== name));
}

/** Which .claude.json a claude child reads, and the env to give it (see the file comment). */
export function claudeJsonLocation(configDir, homeDir, env) {
  const configured = (envValue(env, 'CLAUDE_CONFIG_DIR') ?? '').trim();
  if (configured !== '' && samePath(configured, configDir)) return { file: path.join(path.resolve(configDir), '.claude.json'), childEnv: env };
  if (configured === '' && samePath(configDir, path.join(homeDir, '.claude'))) {
    return { file: path.join(path.resolve(homeDir), '.claude.json'), childEnv: withoutVar(env, 'CLAUDE_CONFIG_DIR') };
  }
  return {
    file: path.join(path.resolve(configDir), '.claude.json'),
    childEnv: { ...withoutVar(env, 'CLAUDE_CONFIG_DIR'), CLAUDE_CONFIG_DIR: path.resolve(configDir) },
  };
}

/** `claude` on PATH as an absolute path (local absolute entries only; claude.com/claude.exe on Windows), or null. */
export function findClaude(env) {
  const value = envValue(env, 'PATH') ?? '';
  const names = process.platform === 'win32' ? ['claude.com', 'claude.exe'] : ['claude'];
  for (const raw of value.split(path.delimiter)) {
    const dir = raw.replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(dir) || dir.startsWith('\\\\')) continue;
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // not there
      }
    }
  }
  return null;
}

function readClaudeJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err && err.code === 'ENOENT' ? { state: 'missing', value: {} } : { state: 'unreadable' };
  }
  const body = text.replace(/^﻿/, '');
  if (body.trim() === '') return { state: 'ok', value: {} };
  try {
    return { state: 'ok', value: JSON.parse(body) };
  } catch {
    return { state: 'unreadable' };
  }
}

function isOurs(entry, script) {
  if (!isObject(entry) || typeof entry.command !== 'string' || !Array.isArray(entry.args)) return false;
  if (entry.type !== undefined && entry.type !== 'stdio') return false;
  if (entry.args.length !== 1 || typeof entry.args[0] !== 'string') return false;
  const norm = (p) => path.win32.normalize(p.replace(/\//g, '\\')).toLowerCase();
  return norm(entry.args[0]) === norm(script);
}

const quote = (s) => (/[\s"'`$&|;<>()]/.test(s) || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s);

/**
 * Plans `mode` ('register' | 'unregister'). Reads only. Returns
 * { mode, state: 'absent'|'ours'|'foreign'|'unreadable', file, serverTarget, args, claude, childEnv, display, notes,
 *   refusal, changed }.
 */
export function planMcp({ mode, configDir, homeDir = os.homedir(), env = process.env, serverSource, nodeCommand = process.execPath, claudeCommand }) {
  const { file, childEnv } = claudeJsonLocation(configDir, homeDir, env);
  const serverTarget = path.join(configDir, 'agent-huddle', MCP_FILENAME);
  const script = toPosix(serverTarget);
  const read = readClaudeJson(file);
  const servers = read.state === 'ok' && isObject(read.value) && isObject(read.value.mcpServers) ? read.value.mcpServers : {};
  const entry = Object.hasOwn(servers, MCP_SERVER_KEY) ? servers[MCP_SERVER_KEY] : undefined;
  const state = read.state === 'unreadable' ? 'unreadable' : entry === undefined ? 'absent' : isOurs(entry, script) ? 'ours' : 'foreign';
  const wouldRun = mode === 'register' ? state === 'absent' : state === 'ours';
  const claude = wouldRun ? (claudeCommand ?? findClaude(childEnv)) : null;
  let refusal = null;
  if (state === 'unreadable') refusal = `${file} is not valid JSON; fix it first.`;
  else if (state === 'foreign')
    refusal =
      mode === 'register'
        ? 'an MCP server named "huddle" that is not Agent Huddle\'s is already registered; it is left as it is (remove or rename it first).'
        : 'the MCP server named "huddle" is not Agent Huddle\'s; it is left as it is.';
  else if (wouldRun && claude === null) refusal = 'claude was not found on PATH.';
  else if (wouldRun && mode === 'register' && !fs.existsSync(serverSource)) refusal = `${serverSource} is missing.`;
  const changed = wouldRun && refusal === null;
  const args = !changed
    ? null
    : mode === 'register'
      ? ['mcp', 'add', '--scope', 'user', MCP_SERVER_KEY, '--', nodeCommand, script]
      : ['mcp', 'remove', '--scope', 'user', MCP_SERVER_KEY];
  const notes = [];
  if (changed && mode === 'register') {
    notes.push(`copy ${MCP_FILENAME} to ${serverTarget}`);
    notes.push(`run: ${[claude, ...args].map(quote).join(' ')}`);
    notes.push(`Claude Code then adds "mcpServers.huddle" = {"type":"stdio","command":${JSON.stringify(nodeCommand)},"args":[${JSON.stringify(script)}]} to ${file}`);
    notes.push('attached sessions get the report_progress tool but not the prompt line managed runs get, so they report less');
  } else if (changed) {
    notes.push(`run: ${[claude, ...args].map(quote).join(' ')}`);
    notes.push(`Claude Code then removes "mcpServers.huddle" from ${file}; remove ${serverTarget}`);
  } else if (refusal === null) {
    notes.push(mode === 'register' ? 'self-report server already registered' : 'no self-report server registered by the Huddle');
  }
  return { mode, state, file, serverTarget, args, claude, childEnv, notes, refusal, changed, script };
}

/** Runs a plan made with `planMcp`. Throws with a short message when the command or the check after it fails. */
export function applyMcp(plan, { serverSource }) {
  if (!plan.changed) return false;
  if (plan.mode === 'register') {
    fs.mkdirSync(path.dirname(plan.serverTarget), { recursive: true });
    const tmp = `${plan.serverTarget}.huddle-tmp-${process.pid}`;
    fs.writeFileSync(tmp, fs.readFileSync(serverSource), { mode: 0o600 });
    fs.renameSync(tmp, plan.serverTarget);
  }
  // Test hook: a .mjs stand-in for claude runs under this node (never a shell).
  const [command, args] = plan.claude.endsWith('.mjs') ? [process.execPath, [plan.claude, ...plan.args]] : [plan.claude, plan.args];
  const r = spawnSync(command, args, { env: plan.childEnv, cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 });
  const read = readClaudeJson(plan.file);
  const servers = read.state === 'ok' && isObject(read.value?.mcpServers) ? read.value.mcpServers : {};
  const registered = isOurs(servers[MCP_SERVER_KEY], plan.script);
  const ok = r.status === 0 && (plan.mode === 'register' ? registered : !registered);
  if (!ok) {
    if (plan.mode === 'register' && !registered) fs.rmSync(plan.serverTarget, { force: true });
    const text = String(r.stderr || r.stdout || r.error?.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`claude mcp ${plan.mode === 'register' ? 'add' : 'remove'} did not do what was expected (exit ${r.status ?? 'none'}${text ? `: ${text}` : ''})`);
  }
  if (plan.mode === 'unregister') fs.rmSync(plan.serverTarget, { force: true });
  return true;
}
