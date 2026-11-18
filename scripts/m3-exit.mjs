#!/usr/bin/env node
/**
 * M3 exit checks with real `claude -p` sessions (WP10). Zero new dependencies, Node 22+.
 *
 *   node scripts/m3-exit.mjs                      dry run: print the plan, run nothing
 *   node scripts/m3-exit.mjs --only approve,kill  dry run of just these
 *   node scripts/m3-exit.mjs --yes                run the five default scenarios, one after another (REAL model usage)
 *   node scripts/m3-exit.mjs --yes --only subnote --model sonnet   spike S14(c), not in the default five
 *   options: --only <ids>  --port 47931  --batch <name>  --hold-seconds 20  --timeout-min 5
 * Real runs cost model usage, so every real run needs --yes; --dry-run always wins. Ask the owner first.
 *
 * Scenarios (each = one fresh headless HuddleCore + one `claude -p --permission-mode default` session):
 *   approve  PermissionRequest held, Huddle sends allow          -> the command runs (PostToolUse follows)
 *   deny     PermissionRequest held, Huddle denies with a marker -> the agent quotes or acts on the message
 *   note     agent.message next_tool before the first tool call  -> the final answer carries the marker line
 *   pause    agent.pause before the first tool, hold, resume     -> run time grows by about the hold, session ends
 *   kill     PermissionRequest held, the Huddle process is killed -> the claude session still finishes (S1: fail open)
 *
 * Safety
 *  - ~/.claude is never written. Hooks and token travel in a per-run `--settings` temp file (S13), deleted afterwards.
 *    The sha256 of ~/.claude/settings.json is taken before and after; a change fails the whole run loudly.
 *  - The Huddle listens on 127.0.0.1:<port> with a fresh random token; its data dir is under .huddle/m3/ and its claude
 *    config dir is a throw-away folder. Only sessions started here report to it, and commands are sent only to the
 *    session id this script generated for that scenario.
 *  - Claude runs in a scratch folder under the OS temp dir (two tiny files), not in this repo.
 * Evidence per scenario: .huddle/m3/exit-<date>/<id>/{events.jsonl, claude-result.json, checks.json, settings.redacted.json}
 * plus summary.json. Evidence is local (.huddle/ is git-ignored) and may contain the prompts below, never the token.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveConfigDir } from './lib/common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..');
export const DEFAULT_M3_PORT = 47931;
export const DEFAULT_HOLD_SECONDS = 20;
/** Seconds. Must equal HOLD_TIMEOUT_S and PERMISSION_TIMEOUT_S in packages/core/src/setup/install-hooks.ts (tested). */
export const PRETOOLUSE_TIMEOUT_S = 600;
export const PERMISSION_TIMEOUT_S = 600;
export const OBSERVE_TIMEOUT_S = 5;
export const TOKEN_HEADER = 'X-Huddle-Token';

/** Event -> hook timeout in seconds, same table as the installer (observation 5 s, SessionEnd 1 s, holds 600 s). */
export const HOOK_TIMEOUTS = {
  UserPromptSubmit: OBSERVE_TIMEOUT_S,
  PreToolUse: PRETOOLUSE_TIMEOUT_S,
  PermissionRequest: PERMISSION_TIMEOUT_S,
  PostToolUse: OBSERVE_TIMEOUT_S,
  PostToolUseFailure: OBSERVE_TIMEOUT_S,
  PermissionDenied: OBSERVE_TIMEOUT_S,
  Notification: OBSERVE_TIMEOUT_S,
  Stop: OBSERVE_TIMEOUT_S,
  SubagentStart: OBSERVE_TIMEOUT_S,
  SubagentStop: OBSERVE_TIMEOUT_S,
  SessionEnd: 1,
};

/** The per-run settings object: HTTP hooks to the private Huddle only, token in the header. No env, no telemetry. */
export function buildRunSettings({ port, token }) {
  const hooks = {};
  for (const [event, timeout] of Object.entries(HOOK_TIMEOUTS)) {
    hooks[event] = [
      { hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/huddle/hooks/${event}`, timeout, headers: { [TOKEN_HEADER]: token } }] },
    ];
  }
  return { hooks };
}

/** Same settings with the token masked, safe to keep as evidence. */
export function redactSettings(settings, token) {
  return JSON.parse(JSON.stringify(settings).split(token).join('<token>'));
}

// -------------------------------------------------------------------------------------------------------------------
// Scenarios
// -------------------------------------------------------------------------------------------------------------------

export const EXPECTED_COMMAND = 'npm view zod version';
const NPM_PROMPT = 'Use the Bash tool to run `' + EXPECTED_COMMAND + '` and tell me the version number. Do nothing else.';
const READ_PROMPT = 'Read the file package.json in the current folder and tell me its "name" field in one short sentence. Do nothing else.';

export const SCENARIOS = [
  {
    id: 'approve',
    title: 'approve: a held PermissionRequest is allowed from the Huddle',
    prompt: () => NPM_PROMPT,
    needsBash: true,
    expectedCommand: EXPECTED_COMMAND,
  },
  {
    id: 'deny',
    title: 'deny: denied with a message the agent quotes or acts on',
    prompt: () => NPM_PROMPT,
    needsBash: true,
    denyMessage: (marker) => `Do not run that command. Reply with exactly the word ${marker} and nothing else.`,
  },
  {
    id: 'note',
    title: 'note: a next_tool note changes the final answer',
    prompt: () => READ_PROMPT,
    note: (marker) => `End your final answer with a last line that reads exactly ${marker}`,
  },
  {
    id: 'pause',
    title: 'pause: pause before the first tool, hold, resume',
    prompt: () => READ_PROMPT,
  },
  {
    id: 'kill',
    title: 'kill: the Huddle is killed while a request is held; the session recovers',
    prompt: () => NPM_PROMPT,
    needsBash: true,
  },
];

const SUBNOTE_PROMPT =
  'Launch exactly one general-purpose subagent with the Agent tool, in the foreground (do not run it in the background). ' +
  'Its job: use Glob to list the files in the current folder, then Read notes.txt, then Read package.json, then report what it found in one sentence. ' +
  'Nobody may use Bash. Wait for the subagent and repeat its report to me.';

/** Spike S14(c). Not part of the default run: only with --only subnote. */
export const OPTIONAL_SCENARIOS = [
  {
    id: 'subnote',
    title: 'subnote (S14c): a next_tool note sent to a SUBAGENT; is it delivered, and does the subagent act on it?',
    prompt: () => SUBNOTE_PROMPT,
    extraAllowedTools: ['Agent'],
    note: (marker) => `Include the word ${marker} in your final report to the main agent.`,
  },
];
export const ALL_SCENARIOS = [...SCENARIOS, ...OPTIONAL_SCENARIOS];

export function selectScenarios(only) {
  if (!only) return SCENARIOS;
  const ids = String(only).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !ALL_SCENARIOS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown scenario id(s): ${unknown.join(', ')} (known: ${ALL_SCENARIOS.map((s) => s.id).join(', ')})`);
  if (!ids.length) throw new Error('--only needs at least one scenario id');
  return ALL_SCENARIOS.filter((s) => ids.includes(s.id));
}

/** A model name for --model: letters, digits, dots and dashes only. Throws otherwise. */
export function checkModel(model) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/.test(model)) {
    throw new Error(`Invalid --model "${String(model)}": use 1-64 letters, digits, "." or "-", starting with a letter or digit.`);
  }
  return model;
}

/** A marker the model will not produce by accident. */
export function newMarker(prefix, rand = crypto.randomBytes(3).toString('hex').toUpperCase()) {
  return `${prefix}-${rand}`;
}

/**
 * `claude -p <prompt> ...`. The prompt goes right after -p (list-valued flags would swallow a trailing prompt, see
 * the recording tool). Reads are pre-allowed so only Bash prompts; writes and the web are denied on the command line.
 */
export function claudeArgs({ settingsFile, sessionId, prompt, model, extraAllowedTools = [] }) {
  return [
    '-p',
    prompt,
    '--permission-mode',
    'default',
    '--settings',
    settingsFile,
    '--session-id',
    sessionId,
    '--output-format',
    'json',
    '--allowedTools',
    ['Read', 'Glob', 'Grep', ...extraAllowedTools].join(','),
    '--disallowedTools',
    'Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch',
    ...(model === undefined ? [] : ['--model', checkModel(model)]),
  ];
}

/** Parse `claude -p --output-format json` stdout (one object, or an array of messages). Never throws. */
export function parseClaudeResult(stdout) {
  let value;
  try {
    value = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return { ok: false, result: '', permissionDenials: null, durationMs: null, costUsd: null, isError: null };
  }
  const obj = Array.isArray(value) ? [...value].reverse().find((m) => m && typeof m === 'object' && m.type === 'result') : value;
  if (!obj || typeof obj !== 'object') return { ok: false, result: '', permissionDenials: null, durationMs: null, costUsd: null, isError: null };
  return {
    ok: true,
    result: typeof obj.result === 'string' ? obj.result : '',
    permissionDenials: Array.isArray(obj.permission_denials) ? obj.permission_denials.length : null,
    durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
    costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
    isError: typeof obj.is_error === 'boolean' ? obj.is_error : null,
  };
}

// -------------------------------------------------------------------------------------------------------------------
// Evaluation: pure. Input is what happened (events of this session, claude's result, timings); output is checks.
// -------------------------------------------------------------------------------------------------------------------

const ofType = (events, type) => events.filter((e) => e.type === type);
const check = (name, pass, detail) => ({ name, pass: Boolean(pass), detail: detail ?? '' });

/**
 * @param {string} id scenario id
 * @param {{events: object[], claude: ReturnType<typeof parseClaudeResult>, exitCode: number|null, timedOut: boolean,
 *   marker?: string, holdSeconds?: number, hostKilled?: boolean, hostExitedBeforeEnd?: boolean}} run
 * @returns {{name: string, pass: boolean, detail: string}[]}
 */
export function evaluateScenario(id, run) {
  const { events, claude, exitCode, timedOut, marker, holdSeconds = DEFAULT_HOLD_SECONDS } = run;
  const finished = [
    check('claude exited 0 without timing out', exitCode === 0 && !timedOut, `exit ${String(exitCode)}${timedOut ? ', timed out' : ''}`),
    check('claude printed a result', claude.ok && claude.result.trim() !== '', claude.ok ? `${claude.result.trim().length} chars` : 'stdout was not JSON'),
  ];
  const bashFinished = () => ofType(events, 'tool.finished').filter((e) => e.toolName === 'Bash');
  const requested = ofType(events, 'approval.requested');
  const resolved = ofType(events, 'approval.resolved');
  switch (id) {
    case 'approve': {
      const r = resolved[0];
      return [
        check('Huddle saw a PermissionRequest for Bash', requested.some((e) => e.request?.toolName === 'Bash'), `${requested.length} request(s)`),
        check('resolved allowed by the user', r?.outcome === 'allowed' && r?.by === 'user', r ? `${r.outcome} by ${r.by}` : 'no approval.resolved'),
        check('PostToolUse followed (tool.finished Bash after the answer)', r !== undefined && bashFinished().some((e) => e.ts >= r.ts), `${bashFinished().length} Bash finish(es)`),
        ...finished,
        check('the answer contains a version number', /\d+\.\d+\.\d+/.test(claude.result), claude.result.trim().slice(0, 80)),
        check('no permission denial recorded by claude', claude.permissionDenials === 0 || claude.permissionDenials === null, `permission_denials: ${String(claude.permissionDenials)}`),
      ];
    }
    case 'deny': {
      const r = resolved[0];
      return [
        check('Huddle saw a PermissionRequest for Bash', requested.some((e) => e.request?.toolName === 'Bash'), `${requested.length} request(s)`),
        check('resolved denied by the user with the marker message', r?.outcome === 'denied' && r?.by === 'user' && Boolean(marker) && String(r?.message ?? '').includes(marker), r ? `${r.outcome} by ${r.by}` : 'no approval.resolved'),
        check('the command did not run (no Bash tool.finished)', bashFinished().length === 0, `${bashFinished().length} Bash finish(es)`),
        ...finished,
        check('the final answer quotes or acts on the message (contains the marker)', Boolean(marker) && claude.result.includes(marker), claude.result.trim().slice(0, 120)),
      ];
    }
    case 'note': {
      const queued = ofType(events, 'message.queued')[0];
      const delivered = ofType(events, 'message.delivered')[0];
      return [
        check('message queued as next_tool', queued?.delivery === 'next_tool', queued ? queued.delivery : 'no message.queued'),
        check('message delivered through PreToolUse context', delivered?.via === 'pre_tool_context' && delivered?.messageId === queued?.messageId, delivered ? delivered.via : 'no message.delivered'),
        ...finished,
        check('the final answer contains the marker line', Boolean(marker) && claude.result.includes(marker), claude.result.trim().slice(-120)),
      ];
    }
    case 'pause': {
      const started = ofType(events, 'hold.started')[0];
      const ended = ofType(events, 'hold.ended')[0];
      const paused = ofType(events, 'control.applied').find((e) => e.action === 'pause');
      const resumed = ofType(events, 'control.applied').find((e) => e.action === 'resume');
      const heldMs = started && ended ? ended.ts - started.ts : null;
      const wantMs = holdSeconds * 1000;
      return [
        check('pause applied, then a PreToolUse was held (hold.started)', Boolean(paused) && Boolean(started), `pause:${Boolean(paused)} hold.started:${Boolean(started)}`),
        check('hold ended because of the resume', ended?.why === 'resumed' && Boolean(resumed), ended ? ended.why : 'no hold.ended'),
        check(`the hold lasted about ${holdSeconds} s`, heldMs !== null && heldMs >= wantMs - 1500 && heldMs <= wantMs + 15000, heldMs === null ? 'unknown' : `${(heldMs / 1000).toFixed(1)} s`),
        ...finished,
        check('total run time is at least the hold', claude.durationMs === null ? heldMs !== null : claude.durationMs >= wantMs - 1500, claude.durationMs === null ? 'duration unknown' : `${(claude.durationMs / 1000).toFixed(1)} s`),
        check('the answer is present (the paused tool call went through)', claude.ok && claude.result.trim() !== '', claude.result.trim().slice(0, 80)),
      ];
    }
    case 'kill': {
      return [
        check('Huddle saw a PermissionRequest for Bash before the kill', requested.some((e) => e.request?.toolName === 'Bash'), `${requested.length} request(s)`),
        check('the request was still held when the Huddle was killed (no approval.resolved)', resolved.length === 0, `${resolved.length} resolved`),
        check('the Huddle process was killed', run.hostKilled === true, String(run.hostKilled)),
        ...finished,
        check('claude finished on its own (headless falls back to deny per S1)', claude.ok && exitCode === 0 && !timedOut, `denials: ${String(claude.permissionDenials)}`),
      ];
    }
    case 'subnote': {
      const f = subnoteFacts(events, marker, claude.result);
      return [
        check('a subagent started (agent.started)', f.subagentKey !== null, f.subagentKey ?? 'no agent.started'),
        check('the note was queued for the subagent as next_tool', f.queued, f.queued ? 'yes' : 'no message.queued for that key'),
        check('S14c delivered: message.delivered through PreToolUse context to the SUBAGENT key', f.delivered, f.delivered ? 'yes' : 'no'),
        ...finished,
        // Reported, never a pass condition: this is the spike's answer.
        check(`S14c acted on (reported, not a pass condition): ${f.actedOn}`, true, f.actedOnDetail),
      ];
    }
    default:
      return [check('known scenario', false, id)];
  }
}

/**
 * May the Huddle ALLOW this request? Only the exact scenario command through Bash. The session runs with the owner's real
 * Claude setup, so anything else (another tool, another command, a compound command) is refused. Pure.
 */
export function judgeApproval(request, expected = EXPECTED_COMMAND) {
  const tool = request?.toolName;
  const command = request?.toolInput?.command;
  if (tool === 'Bash' && typeof command === 'string' && command.trim() === expected) return { ok: true, reason: '' };
  const shown = String(typeof command === 'string' ? command : request?.summary ?? '').replace(/\s+/g, ' ').slice(0, 120);
  return { ok: false, reason: `unexpected command: ${String(tool)} ${shown}`.trim() };
}

/** Mask token-like secrets before text goes into evidence: the run token, API keys, bearer tokens, key=value secrets. */
export function maskSecrets(text, extra = []) {
  let out = String(text);
  for (const secret of extra) if (secret) out = out.split(secret).join('<secret>');
  return out
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '<secret>')
    .replace(/\b(?:ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[A-Za-z0-9_-]{10,}/g, '<secret>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, 'Bearer <secret>')
    .replace(/((?:token|secret|password|passwd|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}]{6,}/gi, '$1<secret>');
}

/**
 * S14(c) facts from the events of one session. delivered: a message.delivered via pre_tool_context whose agentKey is the
 * subagent's (not the main agent's). actedOn: 'yes' when the marker is in the subagent's result (agent.stopped) or the
 * final answer, 'no' when the subagent's result is known and lacks it, else 'unknown'.
 */
export function subnoteFacts(events, marker, finalText = '') {
  const started = ofType(events, 'agent.started')[0];
  const subagentKey = started?.agentKey ?? null;
  const queued = subagentKey !== null && ofType(events, 'message.queued').some((e) => e.agentKey === subagentKey && e.delivery === 'next_tool');
  const delivered = subagentKey !== null && ofType(events, 'message.delivered').some((e) => e.agentKey === subagentKey && e.via === 'pre_tool_context');
  const stopped = ofType(events, 'agent.stopped').find((e) => e.agentKey === subagentKey);
  const subResult = typeof stopped?.result === 'string' ? stopped.result : null;
  let actedOn = 'unknown';
  let actedOnDetail = 'the subagent result was not recorded';
  if (marker && subResult !== null && subResult.includes(marker)) { actedOn = 'yes'; actedOnDetail = 'marker in the subagent result'; }
  else if (marker && String(finalText).includes(marker)) { actedOn = 'yes'; actedOnDetail = 'marker in the final answer'; }
  else if (subResult !== null) { actedOn = 'no'; actedOnDetail = 'subagent result recorded without the marker'; }
  return { subagentKey, queued, delivered, actedOn, actedOnDetail };
}

export function summarize(checks) {
  return { passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length };
}

// -------------------------------------------------------------------------------------------------------------------
// ~/.claude/settings.json guard
// -------------------------------------------------------------------------------------------------------------------

/** sha256 of the file, or "absent". Never throws. */
export function hashSettingsFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'absent' : `unreadable:${err && err.code ? err.code : 'error'}`;
  }
}

export function userSettingsPath() {
  return path.join(resolveConfigDir(), 'settings.json');
}

/** Throws a loud, specific error when the hashes differ. */
export function assertSettingsUnchanged(before, after, file = '~/.claude/settings.json') {
  if (before !== after) {
    throw new Error(`!!! ${file} CHANGED during the run (before ${before.slice(0, 12)}, after ${after.slice(0, 12)}). This script must never touch it. Inspect the file and the backups before doing anything else.`);
  }
}

// -------------------------------------------------------------------------------------------------------------------
// Plan (dry run)
// -------------------------------------------------------------------------------------------------------------------

export function evidenceDirName(now = new Date()) {
  return `exit-${now.toISOString().slice(0, 10)}`;
}

export const BATCH_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export function checkBatch(batch) {
  if (typeof batch !== 'string' || !BATCH_PATTERN.test(batch) || batch.includes('..')) {
    throw new Error(`Invalid --batch "${String(batch)}": use 1-64 letters, digits, ".", "_" or "-" (no "..").`);
  }
  return batch;
}

/** { execute, batch }. Only --yes starts real runs; --dry-run always wins. */
export function planFromArgs(args, now = new Date()) {
  return { execute: !args['dry-run'] && args.yes === true, batch: checkBatch(args.batch ?? evidenceDirName(now)) };
}

export function describePlan({ scenarios, port, batch, holdSeconds, model, log }) {
  log(`Dry run: nothing is executed, no process is started, no file is written. ${scenarios.length} scenario(s), each one real claude -p session when run with --yes.`);
  log(`Evidence would go to .huddle/m3/${batch}/<scenario>/. Huddle: 127.0.0.1:${port}, fresh token per scenario, data dir .huddle/m3/${batch}/<scenario>/data.`);
  log(`Guard: sha256 of ${userSettingsPath()} before and after (now: ${hashSettingsFile(userSettingsPath()).slice(0, 12)}); a change fails the run.`);
  log('Per-run settings file (temp, deleted afterwards; token shown as <token>):');
  log(JSON.stringify(redactSettings(buildRunSettings({ port, token: '<token>' }), '<token>'), null, 2));
  log(`PreToolUse timeout ${PRETOOLUSE_TIMEOUT_S} s, PermissionRequest ${PERMISSION_TIMEOUT_S} s.`);
  log(`Model: ${model ?? '(claude default, no --model flag)'}`);
  log('Scenarios:');
  for (const s of scenarios) {
    log(`  ${s.id.padEnd(8)} ${s.title}`);
    log(`           prompt: ${s.prompt()}`);
    log(`           claude ${claudeArgs({ settingsFile: '<temp settings>', sessionId: '<uuid>', prompt: '"<prompt>"', model, extraAllowedTools: s.extraAllowedTools }).join(' ')}`);
    if (s.id === 'subnote') log('           Huddle: wait for agent.started (the subagent), agent.message next_tool to the SUBAGENT key with a random marker; reports delivered (pass) and acted on (reported only)');
    if (s.id === 'pause') log(`           Huddle: agent.pause right after the prompt arrives, wait for hold.started, hold ${holdSeconds} s, agent.resume`);
    if (s.id === 'approve') log('           Huddle: approval.decide allow on the held request');
    if (s.id === 'deny') log('           Huddle: approval.decide deny with a message that carries a random marker');
    if (s.id === 'note') log('           Huddle: agent.message delivery next_tool asking for a random marker as the last line');
    if (s.id === 'kill') log('           Huddle: wait for the held request, then kill the Huddle process (taskkill /F /T on Windows)');
  }
  log('Cost: about one short claude turn per scenario (two to three model calls each). Re-run with --yes to start (ask the owner first).');
}

// -------------------------------------------------------------------------------------------------------------------
// Real runs
// -------------------------------------------------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Starts the headless Huddle child. Resolves a handle; rejects if it does not report ready in 30 s. */
export function startHost({ port, token, dataDir, claudeDir, onEvents }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, 'lib', 'm3-host.mjs'), '--port', String(port), '--data-dir', dataDir, '--claude-dir', claudeDir], {
      cwd: REPO,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(token + '\n'); // the token never travels in argv
    let stderr = '';
    let settled = false;
    let exited = false;
    const pending = new Map();
    const handle = {
      pid: child.pid,
      get exited() { return exited; },
      command(command, sessionId) {
        const id = crypto.randomUUID();
        return new Promise((res) => {
          pending.set(id, res);
          child.stdin.write(`${JSON.stringify({ op: 'command', id, command, sessionId })}\n`);
          setTimeout(() => { if (pending.delete(id)) res({ ok: false, code: 'failed', message: 'host did not answer' }); }, 10000);
        });
      },
      kill() {
        if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      },
      async dispose() {
        if (exited) return;
        try { child.stdin.write('{"op":"dispose"}\n'); } catch { /* already gone */ }
        await Promise.race([new Promise((r) => child.once('exit', r)), sleep(8000)]);
        if (!exited) handle.kill();
      },
      whenExited: new Promise((r) => child.once('exit', () => r())),
    };
    const timer = setTimeout(() => { if (!settled) { settled = true; handle.kill(); reject(new Error(`Huddle host did not start in 30 s: ${stderr.slice(0, 500)}`)); } }, 30000);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.op === 'ready' && !settled) { settled = true; clearTimeout(timer); resolve(handle); }
      else if (msg.op === 'start-failed' && !settled) { settled = true; clearTimeout(timer); reject(new Error(`Huddle host failed to start: ${msg.message}`)); }
      else if (msg.op === 'events') onEvents(msg.events);
      else if (msg.op === 'result') { const res = pending.get(msg.id); if (res) { pending.delete(msg.id); res(msg.result); } }
    });
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
    child.on('exit', (code) => {
      exited = true;
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error(`Huddle host exited (${String(code)}) before it was ready: ${stderr.slice(0, 500)}`)); }
    });
  });
}

/** Run claude and resolve { exitCode, timedOut, stdout, stderr }. Never rejects. CLAUDE_BIN overrides (a .mjs runs under node). */
export function spawnClaude({ args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const bin = process.env.CLAUDE_BIN || 'claude';
    const isScript = bin.endsWith('.mjs');
    const child = spawn(isScript ? process.execPath : bin, isScript ? [bin, ...args] : args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { if (stdout.length < 2_000_000) stdout += String(d); });
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: -1, timedOut, stdout, stderr: String(e.message) }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, timedOut, stdout, stderr: stderr.trim() }); });
  });
}

/** Wait until `pred(events)` returns something truthy; rejects with `what` after timeoutMs. */
function makeWaiter(events) {
  return async (what, pred, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = pred(events);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
      await sleep(100);
    }
  };
}

/** The Huddle-side actions of each scenario. `ctx` = { events, waitFor, host, sessionId, marker, holdSeconds, flags }. */
const DRIVERS = {
  async approve(ctx) {
    const req = await ctx.waitFor('an approval request (is `npm view` allowed by a rule in your Claude settings?)', (ev) => ev.find((e) => e.type === 'approval.requested'), 120000);
    const verdict = judgeApproval(req.request, ctx.scenario.expectedCommand);
    if (!verdict.ok) {
      ctx.note(`deny ${req.request.requestId}: ${verdict.reason}`);
      await ctx.host.command({ type: 'approval.decide', requestId: req.request.requestId, decision: 'deny', message: 'Agent Huddle M3 check: this command is not the one expected. Do not run it.' }, ctx.sessionId);
      throw new Error(verdict.reason);
    }
    ctx.note(`decide allow ${req.request.requestId}`);
    const res = await ctx.host.command({ type: 'approval.decide', requestId: req.request.requestId, decision: 'allow' }, ctx.sessionId);
    if (!res.ok) throw new Error(`approval.decide failed: ${res.message}`);
  },
  async deny(ctx) {
    const req = await ctx.waitFor('an approval request', (ev) => ev.find((e) => e.type === 'approval.requested'), 120000);
    const message = ctx.scenario.denyMessage(ctx.marker);
    ctx.note(`decide deny ${req.request.requestId}: ${message}`);
    const res = await ctx.host.command({ type: 'approval.decide', requestId: req.request.requestId, decision: 'deny', message }, ctx.sessionId);
    if (!res.ok) throw new Error(`approval.decide failed: ${res.message}`);
    // A model may ask again after the deny (Sonnet did, 2026-11-14). A person would deny the repeat too; left unanswered it
    // would sit held until the hook timeout. So every later request in this session is denied with the same message.
    const decided = new Set([req.request.requestId]);
    while (ctx.claudeSettled && !ctx.claudeSettled()) {
      for (const e of ctx.events) {
        if (e.type !== 'approval.requested' || decided.has(e.request.requestId)) continue;
        decided.add(e.request.requestId);
        ctx.note(`decide deny (repeat) ${e.request.requestId}`);
        await ctx.host.command({ type: 'approval.decide', requestId: e.request.requestId, decision: 'deny', message }, ctx.sessionId);
      }
      await sleep(100);
    }
  },
  async note(ctx) {
    await ctx.waitFor('the prompt to reach the Huddle', (ev) => ev.find((e) => e.type === 'prompt.submitted'), 60000);
    const text = ctx.scenario.note(ctx.marker);
    ctx.note(`agent.message next_tool: ${text}`);
    const res = await ctx.host.command({ type: 'agent.message', agentKey: '$MAIN', text, delivery: 'next_tool' }, ctx.sessionId);
    if (!res.ok) throw new Error(`agent.message failed: ${res.message}`);
  },
  async pause(ctx) {
    await ctx.waitFor('the prompt to reach the Huddle', (ev) => ev.find((e) => e.type === 'prompt.submitted'), 60000);
    const p = await ctx.host.command({ type: 'agent.pause', agentKey: '$MAIN' }, ctx.sessionId);
    if (!p.ok) throw new Error(`agent.pause failed: ${p.message} (a tool call may already have started; re-run)`);
    await ctx.waitFor('hold.started (the first tool call held)', (ev) => ev.find((e) => e.type === 'hold.started'), 90000);
    ctx.note(`held; waiting ${ctx.holdSeconds} s`);
    await sleep(ctx.holdSeconds * 1000);
    const r = await ctx.host.command({ type: 'agent.resume', agentKey: '$MAIN' }, ctx.sessionId);
    if (!r.ok) throw new Error(`agent.resume failed: ${r.message}`);
  },
  async subnote(ctx) {
    const started = await ctx.waitFor('the subagent to start (agent.started)', (ev) => ev.find((e) => e.type === 'agent.started'), 120000);
    const text = ctx.scenario.note(ctx.marker);
    ctx.note(`agent.message next_tool to the subagent ${started.agentKey}: ${text}`);
    const res = await ctx.host.command({ type: 'agent.message', agentKey: started.agentKey, text, delivery: 'next_tool' }, ctx.sessionId);
    if (!res.ok) throw new Error(`agent.message to the subagent failed: ${res.message}`);
    // Give the subagent time to make a tool call that follows the note.
    await ctx.waitFor('the note to be delivered or the subagent to end', (ev) => ev.find((e) => e.type === 'message.delivered' || e.type === 'agent.stopped'), 120000).catch(() => undefined);
  },
  async kill(ctx) {
    await ctx.waitFor('an approval request', (ev) => ev.find((e) => e.type === 'approval.requested'), 120000);
    await sleep(1500); // let it be genuinely held for a moment
    ctx.note(`killing the Huddle process (pid ${ctx.host.pid})`);
    ctx.host.kill();
    await ctx.host.whenExited;
    ctx.flags.hostKilled = true;
  },
};

/** Runs one scenario end to end and returns its result entry. Everything it starts is stopped in `finally`. */
export async function runScenario({ scenario, port, batchDir, holdSeconds, timeoutMs, log, scratch, model }) {
  const dir = path.join(batchDir, scenario.id);
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(24).toString('base64url');
  const sessionId = crypto.randomUUID();
  const marker = newMarker(scenario.id === 'deny' ? 'DENIED' : 'NOTE');
  const settings = buildRunSettings({ port, token });
  const settingsFile = path.join(os.tmpdir(), `huddle-m3-${crypto.randomUUID()}.json`);
  const events = [];
  const waitFor = makeWaiter(events);
  const flags = { hostKilled: false };
  const notes = [];
  const entry = { id: scenario.id, sessionId, start: new Date().toISOString(), error: null, checks: [] };
  let host = null;
  let onExit = () => undefined;
  const onSignal = () => { onExit(); process.exit(130); };
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
    onExit = () => { fs.rmSync(settingsFile, { force: true }); host?.kill(); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    fs.writeFileSync(path.join(dir, 'settings.redacted.json'), JSON.stringify(redactSettings(settings, token), null, 2));
    host = await startHost({
      port,
      token,
      dataDir: path.join(dir, 'data'),
      claudeDir: path.join(dir, 'claude-config-throwaway'),
      onEvents: (batch) => { for (const e of batch) if (e.sessionId === sessionId) events.push(e); },
    });
    log(`[${scenario.id}] Huddle up on 127.0.0.1:${port}, session ${sessionId}`);
    const prompt = scenario.prompt();
    const claudeDone = spawnClaude({ args: claudeArgs({ settingsFile, sessionId, prompt, model, extraAllowedTools: scenario.extraAllowedTools }), cwd: scratch, env: { ...process.env }, timeoutMs });
    let claudeSettled = false;
    void claudeDone.then(() => { claudeSettled = true; });
    const ctx = { events, waitFor, host, sessionId, marker, holdSeconds, flags, scenario, claudeSettled: () => claudeSettled, note: (m) => { notes.push(m); log(`[${scenario.id}] ${m}`); } };
    try {
      await DRIVERS[scenario.id](ctx);
    } catch (err) {
      entry.error = String(err?.message ?? err);
      log(`[${scenario.id}] driver stopped: ${entry.error}`);
    }
    const r = await claudeDone;
    await sleep(1000); // last hook posts
    const claude = parseClaudeResult(r.stdout);
    fs.writeFileSync(path.join(dir, 'claude-result.json'), JSON.stringify({ exitCode: r.exitCode, timedOut: r.timedOut, parsed: claude, stderr: maskSecrets(r.stderr.slice(0, 2000), [token]), rawStdout: maskSecrets(r.stdout.slice(0, 20000), [token]) }, null, 2));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    entry.checks = evaluateScenario(scenario.id, { events, claude, exitCode: r.exitCode, timedOut: r.timedOut, marker, holdSeconds, hostKilled: flags.hostKilled });
    entry.notes = notes;
    if (entry.error) entry.checks.push(check('Huddle-side driver finished without error', false, entry.error));
  } catch (err) {
    entry.error = String(err?.message ?? err);
    entry.checks.push(check('scenario ran', false, entry.error));
  } finally {
    entry.end = new Date().toISOString();
    if (host) await host.dispose();
    fs.rmSync(settingsFile, { force: true });
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(entry, null, 2));
  }
  const s = summarize(entry.checks);
  log(`[${scenario.id}] ${s.failed === 0 ? 'PASS' : 'FAIL'} (${s.passed} ok, ${s.failed} failed)`);
  for (const c of entry.checks) log(`    ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` -- ${c.detail}` : ''}`);
  return entry;
}

/** Make a scratch working folder for claude so this repo's CLAUDE.md and settings are not loaded. */
export function makeScratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-m3-work-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'm3-scratch-project', version: '0.0.1', private: true }, null, 2));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'scratch folder for the Agent Huddle M3 exit checks\n');
  return dir;
}

export async function runAll({ scenarios, port, batch, holdSeconds, timeoutMs, model, root = REPO, log = console.log }) {
  const batchDir = path.join(root, '.huddle', 'm3', checkBatch(batch));
  fs.mkdirSync(batchDir, { recursive: true });
  const settingsFile = userSettingsPath();
  const before = hashSettingsFile(settingsFile);
  const scratch = makeScratch();
  const summary = { batch, started: new Date().toISOString(), userSettingsHashBefore: before, scenarios: [] };
  try {
    for (const scenario of scenarios) {
      summary.scenarios.push(await runScenario({ scenario, port, batchDir, holdSeconds, timeoutMs, log, scratch, model }));
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    summary.ended = new Date().toISOString();
    summary.userSettingsHashAfter = hashSettingsFile(settingsFile);
    fs.writeFileSync(path.join(batchDir, 'summary.json'), JSON.stringify(summary, null, 2));
  }
  assertSettingsUnchanged(before, summary.userSettingsHashAfter, settingsFile);
  log(`${settingsFile} unchanged (sha256 ${before.slice(0, 12)}).`);
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ['yes', 'dry-run', 'help'], values: ['only', 'port', 'batch', 'hold-seconds', 'timeout-min', 'model'] });
  if (args.help || args.unknown.length) {
    console.log('usage: node scripts/m3-exit.mjs [--dry-run] [--yes] [--only approve,deny,note,pause,kill,subnote] [--port 47931] [--batch <name>] [--hold-seconds 20] [--timeout-min 5] [--model <name>]\nWithout --yes it is a dry run (also with --only). --yes starts real claude sessions: ask the owner first.');
    process.exit(args.unknown.length ? 1 : 0);
  }
  const scenarios = selectScenarios(args.only);
  const port = Number(args.port ?? DEFAULT_M3_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an integer from 1024 to 65535');
  const holdSeconds = Number(args['hold-seconds'] ?? DEFAULT_HOLD_SECONDS);
  if (!Number.isFinite(holdSeconds) || holdSeconds <= 0 || holdSeconds > 120) throw new Error('--hold-seconds must be between 1 and 120');
  const model = args.model === undefined ? undefined : checkModel(args.model);
  const { execute, batch } = planFromArgs(args);
  if (!execute) return describePlan({ scenarios, port, batch, holdSeconds, model, log: console.log });
  const summary = await runAll({ scenarios, port, batch, holdSeconds, model, timeoutMs: Number(args['timeout-min'] ?? 5) * 60000 });
  const failed = summary.scenarios.filter((s) => s.checks.some((c) => !c.pass));
  console.log(`Done. Evidence: .huddle/m3/${batch}/ (summary.json). ${summary.scenarios.length - failed.length}/${summary.scenarios.length} scenarios passed.`);
  if (failed.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(String(err?.message ?? err)); process.exit(2); });
}
