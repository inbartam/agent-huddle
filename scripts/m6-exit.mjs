#!/usr/bin/env node
/**
 * M6 exit check. Zero new dependencies, Node 22+. Modeled on scripts/m4-exit.mjs and scripts/m5-exit.mjs.
 *
 *   node scripts/m6-exit.mjs                      dry run: print the plan, run nothing
 *   node scripts/m6-exit.mjs --only phone,teams   dry run of just these steps
 *   node scripts/m6-exit.mjs --yes                run every offline step (no `claude`, no model usage)
 *   node scripts/m6-exit.mjs --yes --only mcp     the ONE real-claude step (a managed haiku run): ask the owner first
 *   options: --only <steps>  --out <dir>  --date <YYYY-MM-DD>  --timeout-min 6  --claude-command <file.mjs> (self-test stand-in)
 * `--yes` alone never starts `claude`: the mcp step runs only when it is named in --only. `--dry-run` always wins.
 *
 * The exit criteria (docs/ROADMAP.md M6), one step each:
 *   phone     a real headless HuddleCore (scripts/lib/m6-host.mjs) on a private data folder and a private hook port.
 *             (1) phone access off: nothing listens on a non-loopback address (netstat of the host's pid, plus a connect to every
 *                 non-loopback IPv4 of this computer on the default and on the chosen port);
 *             (2) enable on a real private LAN IPv4 of this computer (none: run the rest on a test-only loopback override and say so);
 *                 pair through the HTTP API within 60 s;
 *             (3) a held PermissionRequest posted to the hook port shows in the phone's live stream in under 2 s; Approve from the
 *                 phone: the hook reply is allow, approval.resolved has by 'user' and via 'phone'; (3b, ADR-030) Pause and
 *                 Resume through POST /api/act, control.applied via 'phone';
 *             (4) auth matrix: no token, wrong token, foreign Origin, wrong Host, revoked: all refused (plus: no message, pause or
 *                 launch route exists; /api/act refuses no token, a foreign Origin and commands off its allowlist); (5) revoke: 401 within 1 s and the stream closes; disable: nothing listens.
 *   teams     fixtures/agent-team.jsonl and agent-team-report.jsonl replayed over the hook port into a headless core: teammates are
 *             kind 'teammate' under the lead and idle after TeammateIdle; the lead check queues one labelled message per idle
 *             teammate when the Huddle's MCP server counts as available (none when it does not); report_teammate finished -> done.
 *   mcp       REAL claude (--yes AND --only mcp): one managed run, --model haiku, launched through run.launch with self-report on:
 *             a three-step task with one subagent. The main agent and the subagent each report >= 1 time, attributed to the right
 *             agent key; the bar basis is self_report or hybrid at some point; the per-run folder is gone after exit; eval:eta
 *             is recorded. With --claude-command <fake.mjs> the same code path runs against the stand-in (the self-test).
 *   attach    the registrar's register -> unregister round trip through HuddleCore against a temp CLAUDE_CONFIG_DIR and the FAKE claude
 *             (packages/core/src/test/fake-claude-mcp.mjs): the file is deep-equal afterwards; the `mcpServers: {}` caveat noted.
 *   packaging apps/desktop/dist/win-unpacked/Agent Huddle.exe --huddle-self-check=<json> (report recorded), and `--remove-hooks`
 *             against a TEMP config folder (CLAUDE_CONFIG_DIR) and a TEMP --user-data-dir: settings.json parsed equal to its original.
 *   hygiene   ~/.claude/settings.json sha256, the `mcpServers` key of ~/.claude.json (the rest of that file changes during normal
 *             use), and the real app data's huddle-settings.json / phone-devices.json: same before and after (always checked).
 *
 * Safety: never touches the real Huddle's data, ~/.claude or running sessions. Ports are private (hook port 0 = a free one, the
 * phone port a free one). No firewall rule is changed. Evidence: .huddle/m6/exit-<date>/ (local only, .huddle/ is git-ignored).
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseArgs } from './lib/common.mjs';
import { assertSettingsUnchanged, buildRunSettings, hashSettingsFile, maskSecrets, redactSettings, userSettingsPath } from './m3-exit.mjs';
import { makeRepo, processesMatching } from './m4-exit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..');
export const PHONE_DEFAULT_PORT = 47835;
export const PACKED_EXE = path.join(REPO, 'apps', 'desktop', 'dist', 'win-unpacked', 'Agent Huddle.exe');
export const ETA_FILE = 'packages/core/src/runtime/eta-eval.test.ts';
export const MCP_TOOL = 'mcp__huddle__report_progress';

export const STEPS = [
  { id: 'phone', real: false, title: 'phone: off = nothing listens off-loopback; pair < 60 s; held approval on the phone < 2 s and Approve = user/phone; Pause/Resume via /api/act = phone; auth matrix and allowlist refused; revoke 401 < 1 s' },
  { id: 'teams', real: false, title: 'teams: agent-team fixtures replayed; teammates kind teammate and idle; one labelled lead check when the server is available; report finished = done' },
  { id: 'mcp', real: true, title: 'mcp (REAL claude, haiku, one run): main and subagent each report >= 1 attributed to the right agent; basis self_report or hybrid; run folder removed; eval:eta recorded' },
  { id: 'attach', real: false, title: 'attach: register -> unregister through HuddleCore against a temp CLAUDE_CONFIG_DIR with the fake claude; file deep-equal' },
  { id: 'packaging', real: false, title: 'packaging: win-unpacked self-check report; --remove-hooks against a temp config folder and temp user-data-dir' },
  { id: 'hygiene', real: false, title: 'hygiene: ~/.claude/settings.json, ~/.claude.json mcpServers, real app-data settings unchanged (always checked)' },
];

export function selectSteps(only) {
  if (!only) return STEPS;
  const ids = String(only).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !STEPS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown step id(s): ${unknown.join(', ')} (known: ${STEPS.map((s) => s.id).join(', ')})`);
  if (!ids.length) throw new Error('--only needs at least one step id');
  return STEPS.filter((s) => ids.includes(s.id) || s.id === 'hygiene');
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Which steps a `--yes` run executes: every step except the real-claude one, unless --only names it. */
export function planFromArgs(argv) {
  const args = parseArgs(argv, { booleans: ['yes', 'dry-run', 'help'], values: ['only', 'out', 'date', 'timeout-min', 'claude-command'] });
  if (args.unknown.length) throw new Error(`Unknown option(s): ${args.unknown.join(', ')}`);
  const date = args.date ?? localDate(new Date());
  const steps = selectSteps(args.only);
  const named = args.only ? String(args.only).split(',').map((s) => s.trim()) : [];
  const willRun = steps.filter((s) => !s.real || named.includes(s.id)).map((s) => s.id);
  const timeoutMin = Number(args['timeout-min'] ?? 6);
  if (!Number.isFinite(timeoutMin) || timeoutMin < 1) throw new Error('--timeout-min must be at least 1');
  return {
    steps,
    willRun,
    run: args.yes === true && args['dry-run'] !== true,
    out: path.resolve(args.out ?? path.join(REPO, '.huddle', 'm6', `exit-${date}`)),
    timeoutMs: timeoutMin * 60_000,
    claudeCommand: args['claude-command'] ? path.resolve(args['claude-command']) : null,
  };
}

// --------------------------------------------------------------------------------------------------------------------------
// The real-claude case: the exact plan (printed by the dry run) and its pure pieces.
// --------------------------------------------------------------------------------------------------------------------------

export const MCP_PROMPT =
  'Do this in three steps. Step 1: use the Glob tool to list the files in the current folder. ' +
  'Step 2: use the Agent tool to start the subagent huddle-counter and ask it to read README.md and tell you how many lines it has. ' +
  'Step 3: reply with one sentence saying how many files you found and how many lines README.md has. ' +
  'Do not run any shell command and do not write or edit any file.';

export function buildMcpTemplate({ cwd, model = 'haiku' }) {
  return {
    id: 'm6-exit-mcp',
    name: 'M6 exit self-report',
    description: 'One small task with one subagent, used by npm run m6:exit -- --yes --only mcp.',
    prompt: MCP_PROMPT,
    cwd,
    mainAgent: null,
    model,
    permissionMode: 'default',
    agents: {
      'huddle-counter': {
        description: 'Reads one file and counts its lines.',
        prompt: 'You read the file you are told to read and answer in one short sentence.',
        tools: ['Read', 'Grep', 'Glob'],
        model,
      },
    },
    selfReport: true,
    worktree: false,
  };
}

/** The harness answers approvals for the read-only tools only; anything else asked is denied. */
export function judgeMcpApproval(request) {
  return ['Read', 'Glob', 'Grep'].includes(request?.toolName);
}

export function mcpPlanLines({ model = 'haiku', claudeCommand = null } = {}) {
  const lines = [];
  lines.push('  REAL claude: one managed run, ' + (claudeCommand ? `STAND-IN ${claudeCommand} (self-test, no model)` : `claude found on PATH, --model ${model} (about a handful of haiku calls; S19 batches cost cents)`));
  lines.push('  Needs --yes AND --only mcp. Ask the owner before running it.');
  lines.push('  Huddle: a headless HuddleCore (scripts/lib/m6-host.mjs --real-claude) on a free private hook port, fresh random token, data dir under the evidence folder,');
  lines.push('          registrar pointed at temp folders + the fake claude (the real ~/.claude.json is never read); launch.skipAttachCheck + a per-run --settings file (HTTP hooks to that port).');
  lines.push('  Temp git repo (hooks off, no signing) as the template cwd. Template:');
  lines.push(JSON.stringify(buildMcpTemplate({ cwd: '<temp repo>', model }), null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
  lines.push('  Per-run settings (token masked):');
  lines.push(JSON.stringify(redactSettings(buildRunSettings({ port: '<free port>', token: '<token>' }), '<token>'), null, 2).split('\n').slice(0, 14).map((l) => `    ${l}`).join('\n') + '\n    ...');
  lines.push('  Launch: run.launch -> the Huddle writes <data>/run-mcp/<runId>/{huddle-mcp.mjs,mcp.json,settings.json} (settings: permissions.allow [' + MCP_TOOL + '] merged with the harness hooks) and spawns');
  lines.push(`          claude -p --input-format stream-json --output-format stream-json --verbose --session-id <runId> --permission-mode default --agents <file> --settings <run-mcp settings> --mcp-config <run-mcp mcp.json> --model ${model}`);
  lines.push('          (no --strict-mcp-config, ADR-025); the prompt plus the Huddle\'s progress line goes over stdin.');
  lines.push('  Harness actions: approval.decide allow for Read/Glob/Grep, deny anything else; after run.result: run.end; wait run.exited; run.stop on any failure path.');
  lines.push('  Sampled every 500 ms: selectProgress basis per agent (the same call the UI makes). Checks: main >= 1 and subagent >= 1 progress.reported, attributed to');
  lines.push('          the main key / a subagent key; basis self_report or hybrid seen; <data>/run-mcp/<runId> gone after run.exited; eval:eta (15 and 30 runs) recorded;');
  lines.push('          ~/.claude/settings.json sha256 and the mcpServers key of ~/.claude.json unchanged.');
  return lines;
}

export function describePlan(plan) {
  const lines = ['M6 exit check, plan (dry run: nothing is executed):'];
  for (const s of plan.steps) lines.push(`  ${s.id.padEnd(10)} ${s.title}`);
  lines.push('');
  lines.push(`--yes would run: ${plan.willRun.join(', ')}${plan.willRun.includes('mcp') ? '' : '   (mcp is not in it: it needs --only mcp)'}`);
  lines.push(`Evidence would go to ${plan.out}`);
  lines.push(`Guard: sha256 of ${userSettingsPath()} (now ${hashSettingsFile(userSettingsPath()).slice(0, 12)}), the mcpServers key of ${path.join(os.homedir(), '.claude.json')}, and the real app data settings, before and after.`);
  if (plan.steps.some((s) => s.id === 'mcp')) {
    lines.push('');
    lines.push('The mcp step, exact plan:');
    lines.push(...mcpPlanLines({ claudeCommand: plan.claudeCommand }));
  }
  lines.push('');
  lines.push('Owner steps this script cannot do: a real phone through the firewall; installer, SmartScreen, auto-start after a reboot, uninstall with settings.json compared as parsed JSON against a backup.');
  return lines;
}

// --------------------------------------------------------------------------------------------------------------------------
// Pure helpers (unit tested)
// --------------------------------------------------------------------------------------------------------------------------

/** sha256 of the `mcpServers` value of a .claude.json (the rest of the file changes while Claude Code is used), "absent", or "unreadable". */
export function mcpServersHash(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
  try {
    const parsed = JSON.parse(text);
    const servers = parsed !== null && typeof parsed === 'object' ? (parsed.mcpServers ?? null) : null;
    return crypto.createHash('sha256').update(JSON.stringify(servers)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

/** TCP listeners of one pid from `netstat -ano -p tcp`: [{address, port}]. */
export function parseNetstat(text, pid) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
    if (m && Number(m[3]) === pid) out.push({ address: m[1], port: Number(m[2]) });
  }
  return out;
}

export const isLoopbackAddress = (a) => a === '127.0.0.1' || a === '[::1]' || a === '::1';

/** Every non-internal IPv4 address of this computer, and which of them the core's rule accepts as a private LAN address. */
export function ipv4Addresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) out.push({ name, ip: info.address });
    }
  }
  return out;
}

/** A row of the auth matrix passes when the status is one of the refusals listed for it. */
export function judgeAuthRows(rows) {
  return rows.map((r) => ({ ...r, pass: r.expect.includes(r.status) }));
}

/** deep-equal round trip verdict of a .claude.json (parsed) before and after; names the mcpServers caveat. */
export function judgeRoundTrip(before, after) {
  const equal = isDeepStrictEqual(before, after);
  const caveat = !equal && !Object.hasOwn(before, 'mcpServers') && isDeepStrictEqual(after, { ...before, mcpServers: {} });
  return { equal, caveat };
}

export const mcpEtaSummary = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(total (tune|judge)|leave-one-out (tune|judge)|prior pairs)/.test(l));

// --------------------------------------------------------------------------------------------------------------------------
// Process, HTTP and network plumbing
// --------------------------------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, pass, detail = '', extra = {}) => ({ name, pass: Boolean(pass), detail: String(detail), ...extra });
const note = (name, detail) => check(name, true, detail, { note: true });

async function waitUntil(what, pred, timeoutMs, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const hit = pred();
    if (hit) return hit;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(stepMs);
  }
}

/** Starts scripts/lib/m6-host.mjs. Resolves a handle; rejects when it is not ready in 60 s. `events` collects what the core appended. */
export function startHost({ token, dataDir, claudeDir, loopback = false, realClaude = false, claudeCommand = null, settingsFile = null }) {
  return new Promise((resolve, reject) => {
    const argv = [path.join(here, 'lib', 'm6-host.mjs'), '--port', '0', '--data-dir', dataDir, '--claude-dir', claudeDir];
    if (loopback) argv.push('--phone-loopback');
    if (realClaude) argv.push('--real-claude');
    if (claudeCommand) argv.push('--claude-command', claudeCommand);
    if (settingsFile) argv.push('--settings-file', settingsFile);
    const child = spawn(process.execPath, argv, { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    child.stdin.write(token + '\n'); // the token never travels in argv
    let stderr = '';
    let settled = false;
    let exited = false;
    const events = [];
    const pending = new Map();
    const ask = (payload) => {
      const id = crypto.randomUUID();
      return new Promise((res) => {
        pending.set(id, res);
        child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
        setTimeout(() => {
          if (pending.delete(id)) res({ ok: false, code: 'failed', message: 'host did not answer' });
        }, 30_000);
      });
    };
    const handle = {
      pid: child.pid,
      port: 0,
      events,
      get exited() {
        return exited;
      },
      command: (command) => ask({ op: 'command', command }),
      query: (query) => ask({ op: 'query', query }),
      agents: () => ask({ op: 'agents' }),
      progress: () => ask({ op: 'progress' }),
      kill() {
        if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      },
      async dispose() {
        if (exited) return;
        try {
          child.stdin.write('{"op":"dispose"}\n');
        } catch {
          /* already gone */
        }
        await Promise.race([new Promise((r) => child.once('exit', r)), sleep(15_000)]);
        if (!exited) handle.kill();
      },
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        handle.kill();
        reject(new Error(`Huddle host did not start in 60 s: ${stderr.slice(0, 500)}`));
      }
    }, 60_000);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.op === 'ready' && !settled) {
        settled = true;
        clearTimeout(timer);
        handle.port = msg.port;
        resolve(handle);
      } else if (msg.op === 'start-failed' && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Huddle host failed to start: ${msg.message}`));
      } else if (msg.op === 'events') events.push(...msg.events);
      else if (msg.op === 'result') {
        const res = pending.get(msg.id);
        if (res) {
          pending.delete(msg.id);
          res(msg.result);
        }
      }
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 4000) stderr += String(d);
    });
    child.on('exit', (code) => {
      exited = true;
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Huddle host exited (${String(code)}) before it was ready: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

/** One HTTP request. `host` is where to connect; `headers.host` overrides the Host header. Never rejects on a status. */
export function httpCall({ host, port, method, pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host,
        port,
        method: method ?? (text === undefined ? 'GET' : 'POST'),
        path: pathname,
        agent: false,
        headers: { ...(text !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

/** A hook POST to the host's 127.0.0.1 hook port. `send()` returns the held request: `done` resolves with the reply. */
function hookPost(port, token, event, payload) {
  const done = httpCall({ host: '127.0.0.1', port, pathname: `/huddle/hooks/${event}`, headers: { 'x-huddle-token': token }, body: payload });
  return done;
}

function tcpProbe(host, port, ms = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      resolve('timeout');
    }, ms);
    s.once('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve('connected');
    });
    s.once('error', (e) => {
      clearTimeout(t);
      resolve(e.code === 'ECONNREFUSED' ? 'refused' : `error:${String(e.code)}`);
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** A live SSE stream to the phone listener; `views` holds every `event: view` frame with the time it arrived. */
function openStream({ host, port, token, headers = {} }) {
  const st = { status: null, views: [], closedAt: null, buf: '' };
  const req = http.get({ host, port, path: '/api/stream', agent: false, headers: { authorization: `Bearer ${token}`, ...headers } }, (res) => {
    st.status = res.statusCode;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      st.buf += chunk;
      for (let i = st.buf.indexOf('\n\n'); i >= 0; i = st.buf.indexOf('\n\n')) {
        const frame = st.buf.slice(0, i);
        st.buf = st.buf.slice(i + 2);
        if (frame.startsWith('event: view\ndata: ')) {
          try {
            st.views.push({ at: performance.now(), view: JSON.parse(frame.slice('event: view\ndata: '.length)) });
          } catch {
            /* a malformed frame is not a view */
          }
        }
      }
    });
    res.on('close', () => {
      st.closedAt ??= performance.now();
    });
  });
  req.on('error', () => {
    st.closedAt ??= performance.now();
  });
  return { st, close: () => req.destroy() };
}

function netstatListeners(pid) {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000 });
  return parseNetstat(r.stdout ?? '', pid);
}

/** Read-only Windows facts about the firewall and the network profile; never throws, never changes a rule. */
function firewallFacts() {
  if (process.platform !== 'win32') return { available: false };
  const script =
    "$p = Get-NetConnectionProfile | ForEach-Object { '{0}={1}' -f $_.InterfaceAlias, $_.NetworkCategory };" +
    "$r = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*\\node.exe' }).Count;" +
    "$w = @(Get-Process | Where-Object { $_.MainWindowTitle -like '*Security Alert*' -or $_.MainWindowTitle -like '*Firewall*' } | ForEach-Object { $_.MainWindowTitle }) -join '|';" +
    "ConvertTo-Json -Compress @{ profiles = @($p); nodeFirewallFilters = $r; alertWindows = $w }";
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 40_000 });
  try {
    return { available: true, ...JSON.parse(String(r.stdout)) };
  } catch {
    return { available: false, error: String(r.stderr ?? '').slice(0, 200) };
  }
}

function tmpRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* a leftover temp folder is not a failure */
  }
}

const ofType = (events, type) => events.filter((e) => e.type === type);

// --------------------------------------------------------------------------------------------------------------------------
// phone
// --------------------------------------------------------------------------------------------------------------------------

const PHONE_SESSION = 'm6-phone-session-0001';
const hookBase = { session_id: PHONE_SESSION, transcript_path: 'C:/Users/user/project/.claude/projects/p/s.jsonl', cwd: 'C:/Users/user/project', permission_mode: 'default' };
const phonePayloads = {
  sessionStart: () => ({ ...hookBase, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-4-7' }),
  prompt: () => ({ ...hookBase, hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' }),
  permission: () => ({
    ...hookBase,
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm view zod version', description: 'Check the zod version' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm view *' }] }],
  }),
};

export async function runPhone({ out, log }) {
  const checks = [];
  const facts = { override: false };
  const root = tmpRoot('huddle-m6-phone-');
  const token = crypto.randomBytes(24).toString('base64url');
  let host = null;
  let stream = null;
  try {
    const paths = { dataDir: path.join(root, 'data'), claudeDir: path.join(root, 'claude') };
    host = await startHost({ token, ...paths });
    const addresses = await host.query({ type: 'phone.addresses' });
    const lan = addresses.ok ? addresses.addresses : [];
    facts.coreAddresses = lan;
    facts.allIPv4 = ipv4Addresses();
    const chosenPort = await freePort();
    facts.chosenPort = chosenPort;

    // (1) off: nothing listens off-loopback.
    const listenersOff = netstatListeners(host.pid);
    const offLoopback = listenersOff.filter((l) => !isLoopbackAddress(l.address));
    const probes = [];
    for (const a of facts.allIPv4) {
      for (const port of [PHONE_DEFAULT_PORT, chosenPort]) probes.push({ ...a, port, result: await tcpProbe(a.ip, port) });
    }
    facts.off = { listeners: listenersOff, probes };
    const chosenOpen = probes.filter((p) => p.port === chosenPort && p.result === 'connected');
    const defaultOpen = probes.filter((p) => p.port === PHONE_DEFAULT_PORT && p.result === 'connected');
    checks.push(check('(1) phone access off: the host process listens on loopback only', listenersOff.length >= 1 && offLoopback.length === 0, `listeners of pid ${host.pid}: ${listenersOff.map((l) => `${l.address}:${l.port}`).join(', ') || 'none seen'}`));
    checks.push(check('(1) off: no connect succeeds on the chosen port on any non-loopback IPv4', probes.length > 0 && chosenOpen.length === 0, `${probes.filter((p) => p.port === chosenPort).map((p) => `${p.ip}:${p.port}=${p.result}`).join(', ') || 'no non-loopback IPv4 on this computer'}`));
    checks.push(note('(1) off: the default port ' + PHONE_DEFAULT_PORT, defaultOpen.length ? `something accepted a connection on ${defaultOpen.map((p) => p.ip).join(', ')}: not this host (its listeners are above); possibly the owner's real Huddle with phone access on` : probes.filter((p) => p.port === PHONE_DEFAULT_PORT).map((p) => `${p.ip}=${p.result}`).join(', ') || 'no address'));

    // (2) enable on a real private LAN IPv4, else the labelled loopback override.
    let ip;
    if (lan.length > 0) {
      ip = lan[0].ip;
    } else {
      facts.override = true;
      await host.dispose();
      host = await startHost({ token, dataDir: path.join(root, 'data2'), claudeDir: path.join(root, 'claude2'), loopback: true });
      ip = '127.0.0.1';
    }
    checks.push(check('(2) a private LAN IPv4 of this computer exists (else: no LAN address, loopback override used)', lan.length > 0, lan.length ? lan.map((a) => `${a.ip} (${a.interfaceName})`).join(', ') : 'no LAN address: the rest ran on the TEST-ONLY loopback override'));
    facts.ip = ip;
    const fwBefore = firewallFacts();
    const enable = await host.command({ type: 'phone.enable', ip, port: chosenPort });
    facts.enable = enable;
    checks.push(check('(2) phone.enable binds that address', enable.ok === true, enable.ok ? String(enable.detail) : String(enable.message)));
    if (!enable.ok) throw new Error(`phone.enable failed: ${String(enable.message)}`);
    await sleep(2000);
    const fwAfter = firewallFacts();
    facts.firewall = { before: fwBefore, after: fwAfter };
    const listenersOn = netstatListeners(host.pid);
    facts.on = { listeners: listenersOn };
    const phoneListener = listenersOn.find((l) => l.port === chosenPort);
    checks.push(check('(2) on: the only non-loopback listener of the host is the chosen address and port', phoneListener?.address === ip && listenersOn.filter((l) => !isLoopbackAddress(l.address)).every((l) => l.address === ip && l.port === chosenPort), listenersOn.map((l) => `${l.address}:${l.port}`).join(', ')));
    checks.push(note('(2) Windows Firewall during the bind (read only; no rule was changed)', fwAfter.available ? `profiles ${JSON.stringify(fwAfter.profiles)}; node.exe application filters ${fwBefore.nodeFirewallFilters} before, ${fwAfter.nodeFirewallFilters} after; security-alert window: ${fwAfter.alertWindows || 'none seen'}. A self-connection from this computer is not filtered, so this says nothing about a phone: owner step` : `could not tell (${fwAfter.error ?? 'not Windows'})`));

    // pair within 60 s through the HTTP API
    const tPair = performance.now();
    const pairCmd = await host.command({ type: 'phone.pair' });
    const code = pairCmd.ok ? pairCmd.phonePairing?.code : undefined;
    checks.push(check('(2) phone.pair hands out a 6-digit code', typeof code === 'string' && /^[0-9]{6}$/.test(code), code ? 'code shown (not kept)' : String(pairCmd.message)));
    const wrong = await httpCall({ host: ip, port: chosenPort, pathname: '/api/pair', headers: { host: `${ip}:${chosenPort}` }, body: { code: code === '000000' ? '111111' : '000000', name: 'wrong code phone' } });
    checks.push(check('(2) a wrong code is refused', wrong.status >= 400 && wrong.status < 500, `HTTP ${wrong.status}`));
    const paired = await httpCall({ host: ip, port: chosenPort, pathname: '/api/pair', headers: { host: `${ip}:${chosenPort}` }, body: { code, name: 'M6 exit phone' } });
    const pairMs = Math.round(performance.now() - tPair);
    let device = null;
    try {
      device = JSON.parse(paired.body);
    } catch {
      /* checked below */
    }
    facts.pairMs = pairMs;
    checks.push(check('(2) pairing through the HTTP API takes under 60 s and returns a device token', paired.status === 200 && typeof device?.token === 'string' && pairMs < 60_000, `HTTP ${paired.status} in ${pairMs} ms`));
    if (!device?.token) throw new Error('pairing failed');
    const auth = { authorization: `Bearer ${device.token}` };
    const authority = `${ip}:${chosenPort}`;
    const call = (opts) => httpCall({ host: ip, port: chosenPort, ...opts, headers: { host: authority, ...(opts.headers ?? {}) } });

    // (3) a held approval reaches the phone in under 2 s; Approve from the phone.
    expectOk(await hookPost(host.port, token, 'SessionStart', phonePayloads.sessionStart()), 'SessionStart');
    expectOk(await hookPost(host.port, token, 'UserPromptSubmit', phonePayloads.prompt()), 'UserPromptSubmit');
    stream = openStream({ host: ip, port: chosenPort, token: device.token, headers: { host: authority } });
    await waitUntil('the phone stream to deliver a first view', () => stream.st.views.length > 0, 5000);
    const tSend = performance.now();
    const heldReply = hookPost(host.port, token, 'PermissionRequest', phonePayloads.permission());
    const approvalSeen = await waitUntil('the approval in the phone stream', () => stream.st.views.find((v) => v.view.inbox?.some((i) => i.kind === 'approval' && i.summary === 'npm view zod version')), 8000, 10);
    const appearMs = Math.round(approvalSeen.at - tSend);
    const approval = approvalSeen.view.inbox.find((i) => i.kind === 'approval');
    facts.appearMs = appearMs;
    checks.push(check('(3) a held PermissionRequest appears in the phone stream in under 2 s', appearMs < 2000, `${appearMs} ms from posting the hook to the stream frame (the stream's own throttle is 500 ms)`));
    const decided = await call({ method: 'POST', pathname: '/api/decide', headers: auth, body: { requestId: approval.requestId, decision: 'allow' } });
    checks.push(check('(3) Approve from the phone is accepted', decided.status === 200, `HTTP ${decided.status}`));
    const reply = await heldReply;
    let behavior = null;
    try {
      behavior = JSON.parse(reply.body)?.hookSpecificOutput?.decision?.behavior ?? null;
    } catch {
      /* checked below */
    }
    checks.push(check('(3) the held hook request gets the allow reply', reply.status === 200 && behavior === 'allow', `HTTP ${reply.status}, decision ${String(behavior)}`));
    await waitUntil('approval.resolved', () => ofType(host.events, 'approval.resolved')[0], 5000);
    const resolved = ofType(host.events, 'approval.resolved').find((e) => e.requestId === approval.requestId);
    checks.push(check("(3) approval.resolved has outcome allowed, by 'user', via 'phone'", resolved?.outcome === 'allowed' && resolved?.by === 'user' && resolved?.via === 'phone', JSON.stringify({ outcome: resolved?.outcome, by: resolved?.by, via: resolved?.via })));
    const second = await call({ method: 'POST', pathname: '/api/decide', headers: auth, body: { requestId: approval.requestId, decision: 'deny' } });
    checks.push(check('(3) a second answer to the same request is refused (409)', second.status === 409, `HTTP ${second.status}`));
    // (3b) ADR-030: an allowlisted action (pause, then resume) from the phone, recorded via 'phone'.
    const paused = await call({ method: 'POST', pathname: '/api/act', headers: auth, body: { type: 'agent.pause', agentKey: PHONE_SESSION } });
    const pauseEvent = await waitUntil('control.applied pause', () => ofType(host.events, 'control.applied').find((e) => e.action === 'pause'), 5000).catch(() => null);
    checks.push(check("(3b) Pause from the phone (POST /api/act) is accepted and recorded via 'phone'", paused.status === 200 && pauseEvent?.via === 'phone', `HTTP ${paused.status}, via ${String(pauseEvent?.via)}`));
    const resumed = await call({ method: 'POST', pathname: '/api/act', headers: auth, body: { type: 'agent.resume', agentKey: PHONE_SESSION } });
    checks.push(check('(3b) Resume from the phone is accepted', resumed.status === 200, `HTTP ${resumed.status}`));

    // (4) the auth matrix.
    const own = `http://${authority}`;
    const rows = judgeAuthRows(
      [
        ['no token', await call({ pathname: '/api/state' }), [401]],
        ['wrong token', await call({ pathname: '/api/state', headers: { authorization: 'Bearer ' + 'x'.repeat(43) } }), [401]],
        ['foreign Origin, valid token', await call({ pathname: '/api/state', headers: { ...auth, origin: 'http://evil.example' } }), [403]],
        ['wrong Host, valid token', await call({ pathname: '/api/state', headers: { ...auth, host: 'evil.example:' + chosenPort } }), [403]],
        ['Host without the port, valid token', await call({ pathname: '/api/state', headers: { ...auth, host: ip } }), [403]],
        ['decide without a token', await call({ method: 'POST', pathname: '/api/decide', body: { requestId: 'x', decision: 'allow' } }), [401]],
        ['decide with a foreign Origin', await call({ method: 'POST', pathname: '/api/decide', headers: { ...auth, origin: 'http://evil.example' }, body: { requestId: 'x', decision: 'allow' } }), [403]],
        ['stream without a token', await call({ pathname: '/api/stream' }), [401]],
        ['no message route', await call({ method: 'POST', pathname: '/api/message', headers: auth, body: { text: 'hi' } }), [404]],
        ['no pause route', await call({ method: 'POST', pathname: '/api/pause', headers: auth, body: {} }), [404]],
        ['no launch route', await call({ method: 'POST', pathname: '/api/launch', headers: auth, body: {} }), [404]],
        ['act without a token', await call({ method: 'POST', pathname: '/api/act', body: { type: 'agent.pause', agentKey: PHONE_SESSION } }), [401]],
        ['act with a foreign Origin', await call({ method: 'POST', pathname: '/api/act', headers: { ...auth, origin: 'http://evil.example' }, body: { type: 'agent.pause', agentKey: PHONE_SESSION } }), [403]],
        ['act: run.launch is not on the allowlist', await call({ method: 'POST', pathname: '/api/act', headers: auth, body: { type: 'run.launch', templateId: 'x' } }), [403]],
        ['act: all.stop is not on the allowlist', await call({ method: 'POST', pathname: '/api/act', headers: auth, body: { type: 'all.stop' } }), [403]],
      ].map(([name, r, expect]) => ({ name, status: r.status, expect })),
    );
    const control = [
      ['valid token, no Origin', await call({ pathname: '/api/state', headers: auth })],
      ['valid token, the listener\'s own Origin', await call({ pathname: '/api/state', headers: { ...auth, origin: own } })],
    ];
    facts.authMatrix = rows;
    facts.authControls = control.map(([name, r]) => ({ name, status: r.status }));
    for (const r of rows) checks.push(check(`(4) refused: ${r.name}`, r.pass, `HTTP ${r.status} (expected ${r.expect.join('/')})`));
    for (const [name, r] of control) checks.push(check(`(4) control, allowed: ${name}`, r.status === 200, `HTTP ${r.status}`));

    // (5) revoke: 401 within 1 s, stream closed; disable: nothing listens.
    const closedBefore = stream.st.closedAt;
    const tRevoke = performance.now();
    const revoke = await host.command({ type: 'phone.revoke', deviceId: device.deviceId });
    const afterRevoke = await call({ pathname: '/api/state', headers: auth });
    const revokeMs = Math.round(performance.now() - tRevoke);
    facts.revokeMs = revokeMs;
    checks.push(check('(5) revoke is accepted', revoke.ok === true, revoke.ok ? 'ok' : String(revoke.message)));
    checks.push(check('(5) after revoke the old token gets 401 within 1 s', afterRevoke.status === 401 && revokeMs < 1000, `HTTP ${afterRevoke.status}, ${revokeMs} ms from sending phone.revoke to the 401`));
    await waitUntil('the revoked stream to close', () => stream.st.closedAt !== null, 1500, 20).catch(() => null);
    checks.push(check('(5) the revoked phone\'s live stream is closed within 1 s', closedBefore === null && stream.st.closedAt !== null && stream.st.closedAt - tRevoke < 1000, stream.st.closedAt === null ? 'still open' : `closed ${Math.round(stream.st.closedAt - tRevoke)} ms after the revoke`));
    const revokedMatrix = await call({ method: 'POST', pathname: '/api/decide', headers: auth, body: { requestId: 'x', decision: 'allow' } });
    checks.push(check('(4) refused: revoked token on decide', revokedMatrix.status === 401, `HTTP ${revokedMatrix.status}`));
    const disable = await host.command({ type: 'phone.disable' });
    await sleep(500);
    const after = await tcpProbe(ip, chosenPort);
    const listenersAfter = netstatListeners(host.pid);
    facts.afterDisable = { probe: after, listeners: listenersAfter };
    checks.push(check('(5) disable: phone.disable accepted and nothing listens on the phone address', disable.ok === true && after !== 'connected' && !listenersAfter.some((l) => l.port === chosenPort), `connect ${after}; listeners ${listenersAfter.map((l) => `${l.address}:${l.port}`).join(', ')}`));
    const secretsInEvents = JSON.stringify(host.events).includes(device.token);
    checks.push(check('the device token appears in no event', !secretsInEvents, secretsInEvents ? 'FOUND' : 'not found'));
  } catch (err) {
    checks.push(check('phone case ran to the end', false, String(err?.message ?? err)));
  } finally {
    stream?.close();
    if (host) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'phone-events.jsonl'), host.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      await host.dispose();
    }
    rmTree(root);
  }
  fs.writeFileSync(path.join(out, 'phone.json'), JSON.stringify(facts, null, 2));
  log(`[phone] ${checks.filter((c) => !c.note && !c.pass).length} failed of ${checks.filter((c) => !c.note).length}`);
  return { checks, facts };
}

function expectOk(reply, what) {
  if (reply.status !== 200) throw new Error(`${what} hook answered HTTP ${reply.status}`);
}

// --------------------------------------------------------------------------------------------------------------------------
// teams
// --------------------------------------------------------------------------------------------------------------------------

function readFixtureLines(name) {
  return fs.readFileSync(path.join(REPO, 'fixtures', name), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function writeClaudeJson(claudeDir, serverState) {
  fs.mkdirSync(claudeDir, { recursive: true });
  const script = path.join(claudeDir, 'agent-huddle', 'huddle-mcp.mjs').replace(/\\/g, '/');
  const servers =
    serverState === 'ours'
      ? { huddle: { type: 'stdio', command: process.execPath, args: [script] } }
      : { huddle: { type: 'stdio', command: 'node', args: ['C:/someone-else/server.mjs'] } };
  fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: servers }));
}

/** Replays a fixture's hook lines over HTTP in file order; `afterLine(line, reply)` runs after each. */
async function replayHooks(host, token, lines, afterLine) {
  const replies = [];
  for (const line of lines) {
    if (line.kind !== 'hook') continue;
    const reply = await hookPost(host.port, token, line.event, line.payload);
    if (reply.status !== 200) throw new Error(`${line.event} hook answered HTTP ${reply.status}`);
    replies.push({ event: line.event, body: reply.body });
    if (afterLine) await afterLine(line, reply);
  }
  return replies;
}

const nodeOf = (agents, idPart) => agents.find((a) => a.key.includes(idPart));

export async function runTeams({ out, log }) {
  const checks = [];
  const facts = {};
  const root = tmpRoot('huddle-m6-teams-');
  const token = crypto.randomBytes(24).toString('base64url');
  const hosts = [];
  try {
    for (const state of ['ours', 'foreign']) {
      const claudeDir = path.join(root, `claude-${state}`);
      writeClaudeJson(claudeDir, state);
      const host = await startHost({ token, dataDir: path.join(root, `data-${state}`), claudeDir });
      hosts.push(host);
      const preview = await host.query({ type: 'setup.selfReportPreview', mode: 'register' });
      const label = state === 'ours' ? 'the server counts as available' : 'a foreign "huddle" server is registered (not available)';
      checks.push(check(`[${state}] registration read from the temp .claude.json: ${label}`, preview.ok === true && preview.preview?.state === state, `preview state ${String(preview.preview?.state)}`));

      // agent-team.jsonl
      const idle = {};
      const lines = readFixtureLines('agent-team.jsonl');
      const replies = await replayHooks(host, token, lines, async (line) => {
        if (line.event === 'TeammateIdle') idle[line.payload.teammate_name] = nodeOf(await host.agents(), line.payload.agent_id)?.status ?? null;
      });
      const agents = await host.agents();
      const lead = agents.find((a) => a.kind === 'main' && a.sessionId.endsWith('0001'));
      const alpha = nodeOf(agents, 'aalpha-');
      const beta = nodeOf(agents, 'abeta-');
      const plain = nodeOf(agents, 'a0000000000000003');
      facts[`${state}-agent-team`] = { agents, idleAtTeammateIdle: idle };
      if (state === 'ours') {
        checks.push(check('[agent-team] alpha and beta are kind teammate, children of the lead', alpha?.kind === 'teammate' && beta?.kind === 'teammate' && alpha.parentKey === lead?.key && beta.parentKey === lead?.key, `alpha ${alpha?.kind}/${alpha?.parentKey === lead?.key ? 'under lead' : 'ELSEWHERE'}, beta ${beta?.kind}/${beta?.parentKey === lead?.key ? 'under lead' : 'ELSEWHERE'}`));
        checks.push(check('[agent-team] the unnamed general-purpose agent stays a plain subagent', plain?.kind === 'subagent', String(plain?.kind)));
        checks.push(check('[agent-team] each teammate is idle right after its TeammateIdle', idle.alpha === 'idle' && idle.beta === 'idle', JSON.stringify(idle)));
      }
      const queued = ofType(host.events, 'message.queued').filter((e) => e.source === 'huddle');
      const names = queued.map((q) => /teammate "([^"]+)"/.exec(q.text)?.[1] ?? '?');
      facts[`${state}-queued`] = queued.map((q) => ({ agentKey: q.agentKey, source: q.source, delivery: q.delivery, text: q.text }));
      if (state === 'ours') {
        checks.push(check('[agent-team] the lead check queued exactly one message per idle teammate (alpha once, beta once)', queued.length === 2 && names.filter((n) => n === 'alpha').length === 1 && names.filter((n) => n === 'beta').length === 1, `${queued.length} message(s) for ${names.join(', ')}`));
        checks.push(check('[agent-team] each is labelled as the Huddle\'s (source huddle, automatic), addressed to the lead', queued.every((q) => q.delivery === 'auto' && q.agentKey === lead?.key && /automatic check, not a message from the user/.test(q.text)), queued.map((q) => `${q.source}/${q.delivery}`).join(', ')));
        const delivered = replies.filter((r) => r.event === 'PreToolUse' && r.body.includes('additionalContext')).map((r) => JSON.parse(r.body).hookSpecificOutput.additionalContext);
        checks.push(check('[agent-team] the delivered text is not prefixed as a note from the user', delivered.length >= 1 && delivered.every((t) => !t.startsWith('Note from the user')), `${delivered.length} delivery(ies) on the lead's PreToolUse`));
        const dupe = lines.find((l) => l.event === 'TeammateIdle');
        await hookPost(host.port, token, 'TeammateIdle', dupe.payload);
        const still = ofType(host.events, 'message.queued').filter((e) => e.source === 'huddle').length;
        checks.push(check('[agent-team] a repeated TeammateIdle for the same idle period queues nothing more', still === 2, `${still} message(s) after the repeat`));
      } else {
        checks.push(check('[agent-team] server not available: nothing is queued', queued.length === 0, `${queued.length} message(s)`));
        checks.push(check('[agent-team] server not available: the teammates are still idle', idle.alpha === 'idle' && idle.beta === 'idle', JSON.stringify(idle)));
      }

      // agent-team-report.jsonl
      if (state === 'ours') {
        await replayHooks(host, token, readFixtureLines('agent-team-report.jsonl'));
        const after = await host.agents();
        const a2 = nodeOf(after, 'aalpha-');
        const reportedKeys = after.filter((a) => a.sessionId.endsWith('0002') && a.name === 'alpha');
        const alpha2 = reportedKeys[0] ?? a2;
        const beta2 = after.find((a) => a.sessionId.endsWith('0002') && a.name === 'beta');
        facts['report-agents'] = after.filter((a) => a.sessionId.endsWith('0002'));
        const reported = ofType(host.events, 'teammate.reported');
        checks.push(check('[agent-team-report] two teammate.reported events were read from report_teammate', reported.length === 2, reported.map((e) => `${e.teammateName}:${e.status}`).join(', ')));
        checks.push(check('[agent-team-report] report_teammate finished -> alpha is done; waiting -> beta stays idle', alpha2?.status === 'done' && beta2?.status === 'idle', `alpha ${alpha2?.status}, beta ${beta2?.status}`));
      }
    }
  } catch (err) {
    checks.push(check('teams case ran to the end', false, String(err?.message ?? err)));
  } finally {
    fs.mkdirSync(out, { recursive: true });
    for (const [i, host] of hosts.entries()) {
      fs.writeFileSync(path.join(out, `teams-events-${i === 0 ? 'available' : 'unavailable'}.jsonl`), host.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      await host.dispose();
    }
    rmTree(root);
  }
  fs.writeFileSync(path.join(out, 'teams.json'), JSON.stringify(facts, null, 2));
  log(`[teams] ${checks.filter((c) => !c.note && !c.pass).length} failed of ${checks.filter((c) => !c.note).length}`);
  return { checks, facts };
}

// --------------------------------------------------------------------------------------------------------------------------
// attach (install round trip with the fake claude)
// --------------------------------------------------------------------------------------------------------------------------

export async function runAttach({ out, log }) {
  const checks = [];
  const facts = {};
  const root = tmpRoot('huddle-m6-attach-');
  const token = crypto.randomBytes(24).toString('base64url');
  let host = null;
  try {
    const claudeDir = path.join(root, 'claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}\n');
    host = await startHost({ token, dataDir: path.join(root, 'data'), claudeDir });
    const claudeJson = path.join(claudeDir, '.claude.json');
    const copy = path.join(claudeDir, 'agent-huddle', 'huddle-mcp.mjs');
    const preview = async (mode) => {
      const r = await host.query({ type: 'setup.selfReportPreview', mode });
      if (!r.ok) throw new Error(`preview ${mode}: ${String(r.message)}`);
      return r.preview;
    };
    for (const [label, original] of [
      ['another server present', { keep: true, numStartups: 7, mcpServers: { other: { type: 'stdio', command: 'x', args: [] } } }],
      ['no mcpServers key', { keep: true, numStartups: 7 }],
    ]) {
      fs.writeFileSync(claudeJson, JSON.stringify(original, null, 2));
      const before = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      const p = await preview('register');
      const bad = await host.command({ type: 'setup.selfReport.register', fingerprint: '0'.repeat(64) });
      const afterBad = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      const reg = await host.command({ type: 'setup.selfReport.register', fingerprint: p.fingerprint });
      const mid = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      const copyAfterRegister = fs.existsSync(copy);
      const ours = (await preview('register')).state;
      const u = await preview('unregister');
      const unreg = await host.command({ type: 'setup.selfReport.unregister', fingerprint: u.fingerprint });
      const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      const verdict = judgeRoundTrip(before, after);
      facts[label] = { before, mid, after, registerCommand: p.commands?.[0] ?? null, unregisterCommand: u.commands?.[0] ?? null };
      checks.push(check(`[${label}] preview shows the exact command and changes nothing (state absent, changed)`, p.state === 'absent' && p.changed === true && (p.commands?.[0] ?? '').includes('mcp add --scope user huddle --'), p.commands?.[0] ?? 'no command'));
      checks.push(check(`[${label}] a stale fingerprint is refused and the file stays`, bad.ok === false && bad.code === 'expired' && isDeepStrictEqual(afterBad, before), `${bad.code ?? 'ok'}`));
      checks.push(check(`[${label}] register with the previewed fingerprint adds only mcpServers.huddle`, reg.ok === true && mid.mcpServers?.huddle?.command !== undefined && mid.keep === true && mid.numStartups === 7 && ours === 'ours' && copyAfterRegister, `state ${ours}, server script copy ${copyAfterRegister ? 'present' : 'missing'}`));
      checks.push(check(`[${label}] unregister: .claude.json is deep-equal to the original`, unreg.ok === true && (verdict.equal || verdict.caveat), verdict.equal ? 'deep-equal' : verdict.caveat ? 'equal EXCEPT an empty "mcpServers": {} left behind (the key was absent before); see the caveat note' : 'NOT equal'));
      if (verdict.caveat) checks.push(note(`[${label}] caveat`, 'the fake claude (which mimics what S19 g saw for add; real remove on an absent key is NOT verified) leaves `"mcpServers": {}` when the key was absent; semantically equal, not deep-equal'));
      checks.push(check(`[${label}] the shipped-script copy is removed again`, !fs.existsSync(copy), fs.existsSync(copy) ? 'still there' : 'removed'));
      checks.push(check(`[${label}] settings.json in the temp config folder untouched by the registration`, fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8') === '{}\n', 'byte-equal'));
    }
  } catch (err) {
    checks.push(check('attach case ran to the end', false, String(err?.message ?? err)));
  } finally {
    if (host) await host.dispose();
    rmTree(root);
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'attach.json'), JSON.stringify(facts, null, 2));
  log(`[attach] ${checks.filter((c) => !c.note && !c.pass).length} failed of ${checks.filter((c) => !c.note).length}`);
  return { checks, facts };
}

// --------------------------------------------------------------------------------------------------------------------------
// mcp (real claude)
// --------------------------------------------------------------------------------------------------------------------------

function vitest(args, env = {}) {
  return spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--maxWorkers=2', ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
}

export async function runMcp({ out, log, timeoutMs, claudeCommand }) {
  const checks = [];
  const facts = {};
  const root = tmpRoot('huddle-m6-mcp-');
  const token = crypto.randomBytes(24).toString('base64url');
  let host = null;
  let repo = null;
  let sessionId = null;
  let done = false;
  const settingsFile = path.join(os.tmpdir(), `huddle-m6-${crypto.randomUUID()}.json`);
  const dataDir = path.join(root, 'data');
  const bases = {};
  try {
    repo = makeRepo();
    // the per-run settings need the host's port, which is only known once it runs: hooks first, a port-0 host, then the file
    // is rewritten with the real port before the launch (the host reads the file at launch).
    fs.writeFileSync(settingsFile, JSON.stringify(buildRunSettings({ port: 1, token }), null, 2), { mode: 0o600 });
    host = await startHost({ token, dataDir, claudeDir: path.join(root, 'claude'), realClaude: claudeCommand === null, claudeCommand, settingsFile });
    fs.writeFileSync(settingsFile, JSON.stringify(buildRunSettings({ port: host.port, token }), null, 2), { mode: 0o600 });
    const template = buildMcpTemplate({ cwd: repo });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'mcp-template.json'), JSON.stringify(template, null, 2));
    const up = await host.command({ type: 'template.upsert', template });
    if (!up.ok) throw new Error(`template.upsert failed: ${String(up.message)}`);
    const launch = await host.command({ type: 'run.launch', templateId: template.id });
    checks.push(check('run.launch accepted and returned the run id', launch.ok === true, launch.ok ? String(launch.detail) : String(launch.message)));
    if (!launch.ok) throw new Error(`run.launch failed: ${String(launch.message)}`);
    sessionId = String(launch.detail);
    const runDir = path.join(dataDir, 'run-mcp', sessionId);
    facts.runFolderDuringRun = fs.existsSync(runDir) ? fs.readdirSync(runDir).sort() : null;
    checks.push(check('the per-run folder run-mcp/<runId> holds the server copy, mcp.json and settings.json while the run lives', Array.isArray(facts.runFolderDuringRun) && ['huddle-mcp.mjs', 'mcp.json', 'settings.json'].every((f) => facts.runFolderDuringRun.includes(f)), JSON.stringify(facts.runFolderDuringRun)));
    // answer approvals and sample the bar basis for the whole run
    const seen = new Set();
    const handler = (async () => {
      while (!done) {
        for (const e of ofType(host.events, 'approval.requested')) {
          if (seen.has(e.request.requestId)) continue;
          seen.add(e.request.requestId);
          if (ofType(host.events, 'approval.resolved').some((r) => r.requestId === e.request.requestId)) continue;
          const allow = judgeMcpApproval(e.request);
          log(`[mcp] ${allow ? 'allow' : 'deny'} ${e.request.toolName}`);
          await host.command(allow ? { type: 'approval.decide', requestId: e.request.requestId, decision: 'allow' } : { type: 'approval.decide', requestId: e.request.requestId, decision: 'deny', message: 'Agent Huddle M6 check: not needed.' });
        }
        const p = await host.progress();
        for (const [key, v] of Object.entries(p ?? {})) (bases[key] ??= new Set()).add(`${v.basis}`);
        await sleep(500);
      }
    })();
    await waitUntil('the run result (the turn finished)', () => ofType(host.events, 'run.result')[0], timeoutMs, 200);
    await host.command({ type: 'run.end', runId: sessionId });
    await waitUntil('run.exited', () => ofType(host.events, 'run.exited')[0], 90_000, 200);
    done = true;
    await handler;
    const exited = ofType(host.events, 'run.exited')[0];
    const agents = await host.agents();
    const main = agents.find((a) => a.kind === 'main' && a.sessionId === sessionId);
    const subKeys = agents.filter((a) => a.kind === 'subagent' && a.sessionId === sessionId).map((a) => a.key);
    const reports = ofType(host.events, 'progress.reported');
    const count = (pred) => reports.filter((e) => pred(e.agentKey)).length;
    facts.agents = agents.filter((a) => a.sessionId === sessionId).map((a) => ({ key: a.key, kind: a.kind, name: a.name, selfReport: a.selfReport }));
    facts.reports = reports.map((e) => ({ agentKey: e.agentKey, fraction: e.fraction, etaMinutes: e.etaMinutes, note: e.note }));
    facts.bases = Object.fromEntries(Object.entries(bases).map(([k, v]) => [k, [...v]]));
    checks.push(check('the run exited as completed (exit 0)', exited?.how === 'completed' && exited?.exitCode === 0, exited ? `${exited.how}, exit ${String(exited.exitCode)}` : 'no run.exited'));
    checks.push(check('the main agent reported >= 1 time, attributed to the main agent key', main !== undefined && count((k) => k === main.key) >= 1, `${main ? count((k) => k === main.key) : 0} report(s) on ${main?.key ?? 'no main'}`));
    checks.push(check('a subagent reported >= 1 time, attributed to a subagent key (not the main agent)', subKeys.length >= 1 && count((k) => subKeys.includes(k)) >= 1, `${subKeys.length} subagent(s); ${count((k) => subKeys.includes(k))} report(s) on them`));
    checks.push(check('every report is attributed to an agent that exists in the run', reports.every((e) => agents.some((a) => a.key === e.agentKey)), `${reports.length} report(s)`));
    const seenBases = new Set(Object.values(bases).flatMap((v) => [...v]));
    checks.push(check('the bar basis was self_report or hybrid at some point (sampled every 500 ms, all agents)', seenBases.has('self_report') || seenBases.has('hybrid'), `bases seen: ${[...seenBases].join(', ') || 'none'}`));
    await waitUntil('the per-run folder to be removed', () => !fs.existsSync(runDir), 15_000, 200).catch(() => null);
    checks.push(check('the per-run folder is removed after the run exits', !fs.existsSync(runDir), fs.existsSync(runDir) ? 'still there' : 'removed'));
    checks.push(note('model usage', claudeCommand ? 'stand-in claude: none' : 'one managed run, haiku; cost is in the run.result event (events file)'));
    // the ETA record
    for (const [name, env] of [['eta-base', { HUDDLE_RUNS: 'base' }], ['eta-all', {}]]) {
      const r = vitest([ETA_FILE, '--reporter=verbose'], env);
      const text = `${r.stdout}\n${r.stderr}`;
      fs.writeFileSync(path.join(out, `mcp-${name}.txt`), text);
      checks.push(check(`eval:eta recorded (${name})`, r.status === 0, mcpEtaSummary(text).join(' | ')));
    }
  } catch (err) {
    checks.push(check('mcp case ran to the end', false, String(err?.message ?? err)));
  } finally {
    done = true;
    if (host && !host.exited && sessionId && ofType(host.events, 'run.exited').length === 0) {
      await host.command({ type: 'run.stop', runId: sessionId }).catch(() => null);
      await waitUntil('run.exited', () => ofType(host.events, 'run.exited')[0], 15_000, 200).catch(() => null);
    }
    if (host) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'mcp-events.jsonl'), host.events.map((e) => maskSecrets(JSON.stringify(e), [token])).join('\n') + '\n');
      await host.dispose();
    }
    fs.rmSync(settingsFile, { force: true });
    if (sessionId) {
      let left = processesMatching(sessionId);
      for (let i = 0; i < 10 && left.length > 0; i++) {
        await sleep(2000);
        left = processesMatching(sessionId);
      }
      checks.push(check('no process left whose command line names the run', left.length === 0, left.length ? `pids ${left.join(',')}` : 'none'));
    }
    if (repo) rmTree(repo);
    rmTree(root);
  }
  fs.writeFileSync(path.join(out, 'mcp.json'), JSON.stringify(facts, null, 2));
  log(`[mcp] ${checks.filter((c) => !c.note && !c.pass).length} failed of ${checks.filter((c) => !c.note).length}`);
  return { checks, facts };
}

// --------------------------------------------------------------------------------------------------------------------------
// packaging
// --------------------------------------------------------------------------------------------------------------------------

function newestMtime(dir, skip = new Set(['node_modules', 'dist', 'out', '.git'])) {
  let newest = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name) || /.test.[a-z]+$/.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

export async function runPackaging({ out, log }) {
  const checks = [];
  const facts = {};
  const root = tmpRoot('huddle-m6-pack-');
  const kill = (pid) => spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  try {
    if (!fs.existsSync(PACKED_EXE)) {
      checks.push(check('the unpacked build exists (apps/desktop/dist/win-unpacked)', false, `${PACKED_EXE} is missing: run npm run package:desktop (takes minutes), then run this step again. Not verified.`));
      return { checks, facts };
    }
    const exeStat = fs.statSync(PACKED_EXE);
    const asar = path.join(path.dirname(PACKED_EXE), 'resources', 'app.asar');
    const asarMtime = fs.existsSync(asar) ? fs.statSync(asar).mtimeMs : exeStat.mtimeMs;
    const newestSource = Math.max(...['apps/desktop/src', 'packages/core/src', 'packages/shared/src'].map((d) => newestMtime(path.join(REPO, d))));
    facts.build = { exeBytes: exeStat.size, builtAt: new Date(asarMtime).toISOString(), newestSourceAt: new Date(newestSource).toISOString() };
    checks.push(note('the unpacked build is newer than every source file it contains', asarMtime >= newestSource ? `built ${facts.build.builtAt}, newest source ${facts.build.newestSourceAt}` : `STALE? built ${facts.build.builtAt}, but a source file changed ${facts.build.newestSourceAt}: re-run npm run package:desktop before trusting this`));
    const version = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${PACKED_EXE.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    facts.productVersion = String(version.stdout).trim();
    checks.push(check('the exe reports product version 0.6.0', facts.productVersion.startsWith('0.6.0'), facts.productVersion || 'unreadable'));

    // self-check with a temp --user-data-dir (the real app data is never used)
    const userData1 = path.join(root, 'userdata-selfcheck');
    const report = path.join(root, 'self-check.json');
    const sc = spawnSync(PACKED_EXE, [`--huddle-self-check=${report}`, `--user-data-dir=${userData1}`], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
    } catch {
      /* checked below */
    }
    facts.selfCheck = parsed;
    fs.mkdirSync(out, { recursive: true });
    if (parsed) fs.writeFileSync(path.join(out, 'self-check.json'), JSON.stringify(parsed, null, 2));
    checks.push(check('--huddle-self-check wrote its report and exited 0', sc.status === 0 && parsed !== null, `exit ${String(sc.status)}${sc.error ? ` (${sc.error.message})` : ''}`));
    const text = JSON.stringify(parsed ?? {});
    checks.push(check('the report says node:sqlite works (memory and file)', /"ok":true/.test(JSON.stringify(parsed?.sqlite ?? parsed?.node_sqlite ?? parsed?.nodeSqlite ?? {})) || (/sqlite/i.test(text) && /"fileRoundTrip":true/.test(text)), JSON.stringify(parsed?.sqlite ?? parsed?.nodeSqlite ?? 'no sqlite key').slice(0, 200)));
    checks.push(check('the shipped files are real files outside app.asar', !/"kind":"missing"/.test(text) && !/"insideAsar":true/.test(text) && /huddle-mcp\.mjs/.test(text), 'forwarder, status line, MCP server, phone page, tray icon: none missing, none inside an asar'));
    checks.push(note('self-check report (key facts)', text.slice(0, 600)));
    checks.push(check('--user-data-dir was honored (the temp folder was populated, so the real app data was not used)', fs.existsSync(userData1) && fs.readdirSync(userData1).length > 0, `${fs.existsSync(userData1) ? fs.readdirSync(userData1).length : 0} entries in the temp user-data-dir`));

    // --remove-hooks against a temp config folder and a temp user-data-dir
    const cfg = path.join(root, 'claude');
    fs.mkdirSync(cfg, { recursive: true });
    const original = { theme: 'dark', env: { KEEP_ME: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, statusLine: { type: 'command', command: 'echo status' } };
    fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(original, null, 2) + '\n');
    const inst = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'install-hooks.mjs'), '--apply', '--config-dir', cfg], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const installed = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    checks.push(check('(setup) the installer script added the Huddle\'s entries to the TEMP settings.json', inst.status === 0 && !isDeepStrictEqual(installed, original), `exit ${String(inst.status)}; ${Object.keys(installed.hooks ?? {}).length} hook events now`));
    const userData2 = path.join(root, 'userdata-remove');
    const child = spawn(PACKED_EXE, ['--remove-hooks', `--user-data-dir=${userData2}`], { env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, stdio: 'ignore', windowsHide: true });
    // The packaged command ends with a message box that waits for OK: poll the file, then end the process tree.
    const t0 = Date.now();
    let restored = false;
    while (Date.now() - t0 < 90_000 && !restored) {
      await sleep(500);
      try {
        restored = isDeepStrictEqual(JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')), original);
      } catch {
        /* mid-write */
      }
    }
    await sleep(1500);
    kill(child.pid);
    const finalSettings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
    facts.removeHooks = { seconds: Math.round((Date.now() - t0) / 100) / 10, finalSettings, backups: fs.readdirSync(cfg).filter((f) => f.startsWith('settings.json.')) };
    checks.push(check('--remove-hooks (temp CLAUDE_CONFIG_DIR, temp --user-data-dir): settings.json parsed equals the original', isDeepStrictEqual(finalSettings, original), isDeepStrictEqual(finalSettings, original) ? `restored in ${facts.removeHooks.seconds} s; a backup file was kept: ${facts.removeHooks.backups.length > 0}` : `DIFFERENT: ${JSON.stringify(finalSettings).slice(0, 400)}`));
    checks.push(note('--remove-hooks shows a message box at the end (it waits for OK): this step ended the process after the file was restored', 'a window may have flashed on the desktop'));
  } catch (err) {
    checks.push(check('packaging case ran to the end', false, String(err?.message ?? err)));
  } finally {
    rmTree(root);
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'packaging.json'), JSON.stringify(facts, null, 2));
  log(`[packaging] ${checks.filter((c) => !c.note && !c.pass).length} failed of ${checks.filter((c) => !c.note).length}`);
  return { checks, facts };
}

// --------------------------------------------------------------------------------------------------------------------------
// hygiene + driver
// --------------------------------------------------------------------------------------------------------------------------

export function realAppDataFiles() {
  const base = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '@huddle', 'desktop');
  return ['huddle-settings.json', 'phone-devices.json'].map((f) => path.join(base, f));
}

function snapshot() {
  return {
    settings: hashSettingsFile(userSettingsPath()),
    mcpServers: mcpServersHash(path.join(os.homedir(), '.claude.json')),
    appData: Object.fromEntries(realAppDataFiles().map((f) => [f, hashSettingsFile(f)])),
  };
}

export async function runAll(plan, log = console.log) {
  fs.mkdirSync(plan.out, { recursive: true });
  const before = snapshot();
  const ids = new Set(plan.willRun);
  const results = {};
  const ctx = { out: plan.out, log, timeoutMs: plan.timeoutMs, claudeCommand: plan.claudeCommand };
  if (ids.has('phone')) results.phone = await runPhone(ctx);
  if (ids.has('teams')) results.teams = await runTeams(ctx);
  if (ids.has('attach')) results.attach = await runAttach(ctx);
  if (ids.has('packaging')) results.packaging = await runPackaging(ctx);
  if (ids.has('mcp')) results.mcp = await runMcp(ctx);
  const after = snapshot();
  const hygiene = [
    check('~/.claude/settings.json sha256 unchanged', before.settings === after.settings, `${before.settings.slice(0, 12)} before, ${after.settings.slice(0, 12)} after`),
    check('~/.claude.json `mcpServers` unchanged (only that key is compared)', before.mcpServers === after.mcpServers, `${before.mcpServers.slice(0, 12)} before, ${after.mcpServers.slice(0, 12)} after`),
    ...Object.keys(before.appData).map((f) => check(`real app data ${path.basename(f)} unchanged`, before.appData[f] === after.appData[f], `${before.appData[f].slice(0, 12)} before, ${after.appData[f].slice(0, 12)} after (a running Huddle may legitimately rewrite it)`)),
  ];
  results.hygiene = { checks: hygiene, facts: { before, after } };
  const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.checks]));
  fs.writeFileSync(path.join(plan.out, 'checks.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(plan.out, 'summary.json'), JSON.stringify({ ran: [...ids], skipped: plan.steps.map((s) => s.id).filter((id) => id !== 'hygiene' && !ids.has(id)), snapshot: { before, after } }, null, 2));
  try {
    assertSettingsUnchanged(before.settings, after.settings, userSettingsPath());
  } catch (err) {
    log(String(err.message));
  }
  return results;
}

export function allPassed(results) {
  return Object.values(results).every((r) => r.checks.every((c) => c.pass));
}

function printResults(results, log) {
  for (const [id, r] of Object.entries(results)) {
    const failed = r.checks.filter((c) => !c.pass).length;
    log(`[${id}] ${failed === 0 ? 'PASS' : 'FAIL'} (${r.checks.filter((c) => c.pass && !c.note).length} ok, ${failed} failed)`);
    for (const c of r.checks) log(`    ${c.note ? 'note' : c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` -- ${c.detail}` : ''}`);
  }
}

async function main() {
  const plan = planFromArgs(process.argv.slice(2));
  if (!plan.run) {
    for (const l of describePlan(plan)) console.log(l);
    console.log('\nDry run: nothing was executed. Run with --yes to execute (mcp additionally needs --only mcp).');
    return 0;
  }
  const results = await runAll(plan);
  printResults(results, console.log);
  console.log(`\nEvidence: ${plan.out}`);
  return allPassed(results) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}

