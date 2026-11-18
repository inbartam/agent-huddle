#!/usr/bin/env node
/**
 * Agent Huddle — connect Claude Code to the Huddle (M0 spike version).
 *
 * It edits your USER-level Claude Code settings (<config dir>/settings.json) so that every
 * Claude Code session on this machine reports to the local Huddle server:
 *   - HTTP hooks for lifecycle, tool, permission, subagent and task events
 *   - one command hook for SessionStart (that event does not support HTTP hooks)
 *   - OpenTelemetry env vars, so token usage per API request reaches the Huddle
 *
 * Safety properties
 *   - DRY RUN by default: nothing is written unless you pass --apply
 *   - a timestamped backup of settings.json is made before every write
 *   - only entries that belong to the Huddle are added or removed; your own hooks are untouched
 *   - existing telemetry settings are never overwritten
 *   - --uninstall removes everything this script added, and puts back your own status line if the app installed
 *     its status line bridge (saved in <config dir>/agent-huddle/statusline-original.json; F9, ADR-018), and the
 *     self-report MCP server if --mcp registered it (F27, ADR-025)
 *   - --mcp (opt-in) registers the self-report MCP server for every session of your user by running
 *     `claude mcp add --scope user huddle -- <node> <config dir>/agent-huddle/huddle-mcp.mjs` (shown first, run only
 *     with --apply). The script never writes ~/.claude.json itself, and never replaces a "huddle" server that is not ours.
 *
 * Usage
 *   node scripts/install-hooks.mjs                      preview the change
 *   node scripts/install-hooks.mjs --apply              write it
 *   node scripts/install-hooks.mjs --mcp                preview the change plus the self-report registration
 *   node scripts/install-hooks.mjs --uninstall --apply  remove it again (the MCP registration too, when it is ours)
 * Options
 *   --mcp               also register the self-report MCP server for attached sessions (claude mcp add --scope user)
 *   --claude-command <p>  tests only: the claude to run for --mcp (a .mjs stand-in runs under this node)
 *   --port <n>          port the Huddle listens on (default 47821, or the one already in config.json)
 *   --events all|core   "core" skips the newest hook events, for older Claude Code versions (default all)
 *   --no-otel           do not add the OpenTelemetry env vars (no token metering)
 *   --show-json         print the resulting settings.json
 *   --config-dir <dir>  Claude config directory (default: CLAUDE_CONFIG_DIR, else ~/.claude)
 *   --timeout Event=s   override one hook's timeout in seconds, repeatable (spike S6: --timeout PreToolUse=60);
 *                       warns when it has no effect (SessionStart, --uninstall, an event not installed)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PORT,
  FORWARDER_FILENAME,
  HOOK_PATH_PREFIX,
  huddleDir,
  parseArgs,
  readJsonIfExists,
  resolveConfigDir,
  shellUnsafePathChar,
  toPosixPath,
} from './lib/common.mjs';
import { applyMcp, MCP_FILENAME, planMcp } from './lib/mcp-register.mjs';

// Events delivered as HTTP hooks. Deliberately NOT registered:
//   WorktreeCreate   a hook on it replaces Claude Code's own worktree creation
//   PreModelSwitch   a slow or missing answer blocks the model switch
//   Elicitation, ConfigChange   can block user-facing flows; nothing the Huddle needs yet
//   MessageDisplay   very chatty, tight timeout
const CORE_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
];
const NEWER_EVENTS = ['PermissionDenied', 'StopFailure', 'TeammateIdle', 'PostModelSwitch', 'InstructionsLoaded'];

// Seconds. Observation hooks get a short timeout so a hung Huddle can never stall an agent.
// PermissionRequest is long because the Huddle holds it open while you decide. PreToolUse is long so the Huddle can
// hold it for a pause or a question window (ADR-019); unheld calls are still answered in about 2 ms.
// Same table as TIMEOUTS in packages/core/src/setup/install-hooks.ts (parity test in install-hooks.test.ts there).
const DEFAULT_TIMEOUT = 5;
const TIMEOUTS = { PreToolUse: 600, PermissionRequest: 600, SessionEnd: 1 };

const TELEMETRY_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_METRIC_EXPORT_INTERVAL',
];

const args = parseArgs(process.argv.slice(2), {
  booleans: ['apply', 'uninstall', 'no-otel', 'show-json', 'help', 'mcp'],
  values: ['port', 'events', 'config-dir', 'timeout', 'claude-command'],
});

if (args.help || args.unknown.length || (args.events && !['all', 'core'].includes(args.events))) {
  if (args.unknown.length) console.error(`Unknown option(s): ${args.unknown.join(', ')}\n`);
  if (args.events && !['all', 'core'].includes(args.events)) console.error('--events must be "all" or "core"\n');
  const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
  console.log(header.replace(/^#!.*\n/, '').replace(/^\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
  process.exit(args.help ? 0 : 1);
}

const configDir = resolveConfigDir(args['config-dir']);
const settingsPath = path.join(configDir, 'settings.json');
const hDir = huddleDir(configDir);
const configPath = path.join(hDir, 'config.json');
const forwarderSource = path.join(path.dirname(fileURLToPath(import.meta.url)), FORWARDER_FILENAME);
const forwarderTarget = path.join(hDir, FORWARDER_FILENAME);

function fail(message) {
  console.error(`\nStopped, nothing was changed.\n${message}`);
  process.exit(1);
}

// --timeout may repeat; parseArgs keeps only the last value, so read every occurrence from argv.
// An override that cannot have an effect is accepted with a warning (deferred minor M4): SessionStart (its command hook
// keeps the default timeout), any override with --uninstall, and an event this run does not install (--events core).
const timeoutOverrides = {};
const timeoutWarnings = [];
{
  const argv = process.argv.slice(2);
  const known = [...CORE_EVENTS, ...NEWER_EVENTS, 'SessionStart'];
  for (let i = 0; i < argv.length; i++) {
    let value;
    if (argv[i] === '--timeout') value = argv[++i];
    else if (argv[i].startsWith('--timeout=')) value = argv[i].slice('--timeout='.length);
    else continue;
    const m = /^([A-Za-z]+)=(\d+)$/.exec(String(value ?? ''));
    if (!m || !known.includes(m[1]) || Number(m[2]) <= 0) {
      fail(`--timeout expects Event=seconds with a known event and a positive whole number, got "${value}".\nKnown events: ${known.join(', ')}`);
    }
    timeoutOverrides[m[1]] = Number(m[2]);
  }
  const installed = args.events === 'core' ? CORE_EVENTS : [...CORE_EVENTS, ...NEWER_EVENTS];
  for (const event of Object.keys(timeoutOverrides)) {
    if (args.uninstall) timeoutWarnings.push(`--timeout ${event}=... has no effect with --uninstall.`);
    else if (event === 'SessionStart')
      timeoutWarnings.push('--timeout SessionStart=... has no effect: the SessionStart command hook keeps its default timeout.');
    else if (!installed.includes(event))
      timeoutWarnings.push(`--timeout ${event}=... has no effect: ${event} is not installed with --events ${args.events}.`);
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Exactly what this script writes (same rules as isHuddleHook in packages/core/src/setup/install-hooks.ts).
const OUR_HOOK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/huddle\/hooks\/[A-Za-z]+$/;
const OUR_FORWARDER_COMMAND = /^node "(?:[A-Za-z]:)?[\\/](?:[^"\n]*[\\/])?agent-huddle[\\/]huddle-forward-hook\.mjs"$/;

/**
 * A hook entry belongs to the Huddle only when it is exactly what this script writes: a user's own hook that merely
 * mentions /huddle/hooks/ or the forwarder's file name (a wrapper, an https URL) is theirs and survives --uninstall.
 */
function isOurs(hook) {
  if (!isPlainObject(hook)) return false;
  if (hook.type === 'http') return typeof hook.url === 'string' && OUR_HOOK_URL.test(hook.url);
  if (hook.type === 'command') return typeof hook.command === 'string' && OUR_FORWARDER_COMMAND.test(hook.command);
  return false;
}

/** Remove Huddle entries from settings.hooks; returns how many were removed. */
function stripOurHooks(settings) {
  let removed = 0;
  if (!isPlainObject(settings.hooks)) return removed;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const hooks = group.hooks.filter((h) => !isOurs(h));
      removed += group.hooks.length - hooks.length;
      if (hooks.length) kept.push({ ...group, hooks });
    }
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

/** Telemetry env is "ours" only when it points at a local Huddle with our token header. */
function telemetryIsOurs(env) {
  return (
    isPlainObject(env) &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(String(env.OTEL_EXPORTER_OTLP_ENDPOINT || '')) &&
    String(env.OTEL_EXPORTER_OTLP_HEADERS || '').startsWith('X-Huddle-Token=')
  );
}

function stripOurTelemetry(settings) {
  if (!telemetryIsOurs(settings.env)) return 0;
  let removed = 0;
  for (const key of TELEMETRY_KEYS) {
    if (key in settings.env) {
      delete settings.env[key];
      removed += 1;
    }
  }
  if (!Object.keys(settings.env).length) delete settings.env;
  return removed;
}

// Status line bridge (F9, ADR-018). This script never installs it; --uninstall puts the user's line back.
// Same ownership rule as isHuddleStatusLine in packages/core/src/setup/install-hooks.ts: exactly our command.
const OUR_STATUSLINE_COMMAND = /^node "(?:[A-Za-z]:)?[\\/](?:[^"\n]*[\\/])?agent-huddle[\\/]huddle-statusline\.mjs"$/;
const STATUSLINE_ORIGINAL = 'statusline-original.json';

function statusLineIsOurs(value) {
  return isPlainObject(value) && value.type === 'command' && typeof value.command === 'string' && OUR_STATUSLINE_COMMAND.test(value.command);
}

/**
 * Restores the saved status line in `settings` (in place). Returns true when statusline-original.json is done with.
 * Saved "none" (null) removes the key. No saved file: statusLine is left alone and a note says so.
 */
function restoreStatusLine(settings, savedPath, notes) {
  const saved = readJsonIfExists(savedPath);
  const record = saved.ok && isPlainObject(saved.value) && 'statusLine' in saved.value ? saved.value : null;
  if (!statusLineIsOurs(settings.statusLine)) {
    if (record) notes.push('leave statusLine as it is: it was changed after the Huddle installed its status line bridge');
    return record !== null;
  }
  if (!record) {
    notes.push(`leave the status line bridge in place: the saved original (${savedPath}) is missing, so there is nothing to restore`);
    return false;
  }
  if (record.statusLine === null || record.statusLine === undefined) {
    delete settings.statusLine;
    notes.push('remove the status line bridge (there was no status line before)');
  } else {
    settings.statusLine = structuredClone(record.statusLine);
    notes.push('restore your own status line');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Read current state
// ---------------------------------------------------------------------------
const settingsRead = readJsonIfExists(settingsPath);
if (!settingsRead.ok) {
  // settingsRead.error is a line and column at most, never a fragment of the file (it can hold API keys).
  fail(`${settingsPath} is ${settingsRead.error}.\nFix or remove the file first; this script will not overwrite a file it cannot read.`);
}
const current = settingsRead.value ?? {};
if (!isPlainObject(current)) fail(`${settingsPath} does not contain a JSON object.`);
if ('hooks' in current && !isPlainObject(current.hooks)) fail(`"hooks" in ${settingsPath} is not an object.`);
if ('env' in current && !isPlainObject(current.env)) fail(`"env" in ${settingsPath} is not an object.`);

const configRead = readJsonIfExists(configPath);
const existingConfig = configRead.ok && isPlainObject(configRead.value) ? configRead.value : {};
const port = Number(args.port ?? existingConfig.port ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port must be an integer between 1024 and 65535.');
const token = existingConfig.token || crypto.randomBytes(24).toString('base64url');
const tokenIsNew = !existingConfig.token;
const events = args.events === 'core' ? CORE_EVENTS : [...CORE_EVENTS, ...NEWER_EVENTS];

// ---------------------------------------------------------------------------
// Build the new settings
// ---------------------------------------------------------------------------
if (!args.uninstall) {
  for (const [what, p] of [
    ['hook forwarder', forwarderTarget],
    ['installer script', fileURLToPath(import.meta.url)],
  ]) {
    const ch = shellUnsafePathChar(p);
    if (ch !== null) {
      const shown = ch === '`' ? 'a backtick' : `"${ch}"`;
      fail(`The ${what} path (${p}) contains ${shown}, so a command with it cannot be quoted safely for every shell.\nUse a config folder without $, backtick, " or %.`);
    }
  }
  if (isPlainObject(current.hooks)) {
    for (const event of [...events, 'SessionStart']) {
      if (event in current.hooks && !Array.isArray(current.hooks[event])) fail(`"hooks.${event}" in ${settingsPath} is not an array.`);
    }
  }
}

const next = structuredClone(current);
const notes = [];
const warnings = [...timeoutWarnings];

const removedHooks = stripOurHooks(next);
const statuslineOriginalPath = path.join(hDir, STATUSLINE_ORIGINAL);
let forgetStatuslineOriginal = false;

if (args.uninstall) {
  forgetStatuslineOriginal = restoreStatusLine(next, statuslineOriginalPath, notes);
  const removedEnv = stripOurTelemetry(next);
  notes.push(`remove ${removedHooks} Huddle hook entr${removedHooks === 1 ? 'y' : 'ies'}`);
  notes.push(`remove ${removedEnv} Huddle telemetry env var${removedEnv === 1 ? '' : 's'}`);
  notes.push(`keep ${hDir} (delete that folder yourself if you want the token and forwarder gone)`);
} else {
  if (removedHooks) notes.push(`replace ${removedHooks} existing Huddle hook entr${removedHooks === 1 ? 'y' : 'ies'} (re-install)`);
  next.hooks = isPlainObject(next.hooks) ? next.hooks : {};
  for (const event of events) {
    const entry = {
      type: 'http',
      url: `http://127.0.0.1:${port}${HOOK_PATH_PREFIX}${event}`,
      timeout: timeoutOverrides[event] ?? TIMEOUTS[event] ?? DEFAULT_TIMEOUT,
      headers: { 'X-Huddle-Token': token },
    };
    next.hooks[event] = [...(Array.isArray(next.hooks[event]) ? next.hooks[event] : []), { hooks: [entry] }];
  }
  // SessionStart only supports command hooks. Shell form with forward slashes runs in Git Bash and PowerShell.
  const startEntry = { type: 'command', command: `node "${toPosixPath(forwarderTarget)}"`, timeout: DEFAULT_TIMEOUT };
  next.hooks.SessionStart = [...(Array.isArray(next.hooks.SessionStart) ? next.hooks.SessionStart : []), { hooks: [startEntry] }];
  notes.push(`add HTTP hooks for ${events.length} events -> http://127.0.0.1:${port}${HOOK_PATH_PREFIX}<Event>`);
  notes.push(`add a SessionStart command hook -> node "${toPosixPath(forwarderTarget)}"`);

  if (args['no-otel']) {
    const removedEnv = stripOurTelemetry(next);
    if (removedEnv) notes.push(`remove ${removedEnv} Huddle telemetry env var${removedEnv === 1 ? '' : 's'} from an earlier install`);
    notes.push('skip telemetry (--no-otel): the Huddle will not see token usage');
  } else {
    stripOurTelemetry(next);
    const env = isPlainObject(next.env) ? next.env : {};
    const foreign = TELEMETRY_KEYS.filter((k) => k in env);
    if (foreign.length) {
      warnings.push(
        `You already have telemetry settings (${foreign.join(', ')}). They are left untouched,\n` +
          '  so the Huddle will not receive token usage. See docs/INTEGRATION.md, section "OpenTelemetry".',
      );
    } else {
      next.env = {
        ...env,
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
        OTEL_EXPORTER_OTLP_HEADERS: `X-Huddle-Token=${token}`,
        OTEL_LOGS_EXPORT_INTERVAL: '2000',
        OTEL_METRIC_EXPORT_INTERVAL: '10000',
      };
      notes.push(`add ${TELEMETRY_KEYS.length} telemetry env vars (OTLP http/json -> http://127.0.0.1:${port}); prompt and tool content logging stay off`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report, then write if asked
// ---------------------------------------------------------------------------
const changed = JSON.stringify(current) !== JSON.stringify(next);
console.log(`${args.uninstall ? 'Uninstall' : 'Install'} Agent Huddle hooks ${args.apply ? '' : '(DRY RUN)'}`);
console.log(`  settings file  ${settingsPath}${settingsRead.exists ? '' : '  (does not exist yet, will be created)'}`);
console.log(`  huddle folder  ${hDir}`);
for (const n of notes) console.log(`  - ${n}`);
for (const w of warnings) console.log(`  ! ${w}`);
if (args['show-json']) console.log(`\n${JSON.stringify(next, null, 2).replaceAll(token, '<token>')}\n`);

// Self-report MCP server (F27, ADR-025): registered only with --mcp; removed by --uninstall when it is ours.
if (args.mcp || args.uninstall) {
  const mcpSource = path.join(path.dirname(fileURLToPath(import.meta.url)), MCP_FILENAME);
  const mcp = planMcp({
    mode: args.uninstall ? 'unregister' : 'register',
    configDir,
    serverSource: mcpSource,
    ...(args['claude-command'] ? { claudeCommand: path.resolve(args['claude-command']) } : {}),
  });
  console.log(`\n${args.uninstall ? 'Remove' : 'Register'} the self-report MCP server ${args.apply ? '' : '(DRY RUN)'}`);
  console.log(`  claude config  ${mcp.file}`);
  for (const n of mcp.notes) console.log(`  - ${n}`);
  if (mcp.refusal) {
    if (args.mcp && !args.uninstall) fail(`The self-report server was not registered: ${mcp.refusal}`);
    console.log(`  ! ${mcp.refusal}`);
  } else if (args.apply && mcp.changed) {
    try {
      applyMcp(mcp, { serverSource: mcpSource });
      console.log(`  ${args.uninstall ? 'removed' : 'registered'}.`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
}

if (!changed) {
  if (args.apply && forgetStatuslineOriginal) fs.rmSync(statuslineOriginalPath, { force: true });
  console.log('\nNothing to change.');
  process.exit(0);
}
if (!args.apply) {
  console.log(`\nNothing was written. Run again with --apply to make this change${args['show-json'] ? '' : ' (add --show-json to see the full file first)'}.`);
  process.exit(0);
}

/**
 * settings.json, its backups and config.json carry the token: owner-only (0o600), written to a temp file in the same
 * folder and renamed over the target, so a crash never leaves half a file. Windows mostly ignores the mode bits.
 */
function writeFileAtomicSync(file, data) {
  const tmp = `${file}.huddle-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** A symlinked settings.json (dotfiles in a repo) is written through: the link's target is replaced, the link stays. */
function writeTargetOf(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return fs.realpathSync(file);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  return file;
}

fs.mkdirSync(hDir, { recursive: true });
if (!args.uninstall) {
  fs.copyFileSync(forwarderSource, forwarderTarget);
  // The SessionStart forwarder names this command when the Huddle is not running (ADR-014 hint).
  const uninstallCommand = `node "${toPosixPath(fileURLToPath(import.meta.url))}" --uninstall --apply --config-dir "${toPosixPath(configDir)}"`;
  const config = { ...existingConfig, port, token, uninstallCommand, updatedAt: new Date().toISOString() };
  writeFileAtomicSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
let backupPath = null;
if (settingsRead.exists) {
  // Milliseconds in the stamp, and a counter when the name is taken: install then uninstall never share a backup.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '').slice(0, 18);
  backupPath = `${settingsPath}.huddle-backup-${stamp}`;
  for (let n = 1; fs.existsSync(backupPath); n++) backupPath = `${settingsPath}.huddle-backup-${stamp}-${n}`;
  // A copy of the content (not copyFileSync, which keeps the source's mode), owner-only.
  writeFileAtomicSync(backupPath, fs.readFileSync(settingsPath));
}
fs.mkdirSync(configDir, { recursive: true });
writeFileAtomicSync(writeTargetOf(settingsPath), `${JSON.stringify(next, null, 2)}\n`);
if (forgetStatuslineOriginal) fs.rmSync(statuslineOriginalPath, { force: true });

console.log('\nDone.');
if (backupPath) console.log(`  backup         ${backupPath}`);
if (!args.uninstall) {
  console.log(`  token          ${tokenIsNew ? 'new token created' : 'existing token kept'} in ${configPath}`);
  console.log('\nNext: start the Agent Huddle app, then start a NEW Claude Code session.');
  console.log('Sessions that were already running may not pick the hooks up until you restart them.');
}
