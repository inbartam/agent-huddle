#!/usr/bin/env node
/**
 * M4 exit check with a real managed `claude` run (WP9). Zero new dependencies, Node 22+. Modeled on scripts/m3-exit.mjs.
 *
 *   node scripts/m4-exit.mjs                      dry run: print the plan, run nothing
 *   node scripts/m4-exit.mjs --only launch,rules  dry run of just these steps
 *   node scripts/m4-exit.mjs --yes                run the whole scenario once (REAL model usage: one three-subagent run)
 *   options: --only <steps>  --port 47941  --batch <name>  --model sonnet  --timeout-min 10
 *            --claude-command <file.mjs>  --worktree-dir <dir>   (the last two are for the self-test with a fake claude)
 * Real runs cost model usage, so every real run needs --yes; --dry-run always wins. Ask the owner first.
 *
 * The exit criterion (docs/ROADMAP.md M4): launch a three-agent template into a worktree with a token budget; watch it
 * pause at the budget; approve by rule without a prompt for safe commands and get asked for the rest; discard the
 * worktree from the app. One scenario, six steps, each with its own pass/fail:
 *   launch    a. template.upsert (three read-only agents, worktree on, default permission mode, a pause budget), run.launch
 *   worktree  b. worktree under <LOCALAPPDATA>/agent-huddle/worktrees/<runId> on huddle/<runId>; the root is managed, sessionCwd = worktree
 *   rules     c. `node --version` / `npm --version` are answered by a default rule (no inbox item; FAILS if no rule answered anything); `node -e` is asked and the harness allows it
 *   budget    d. an exceed item, control.applied pause (source huddle), a held PreToolUse; then the budget is raised and the run resumed
 *   discard   e. run.exited, worktree.summarized, run.discardWorktree -> worktree.closed discarded; folder and branch gone
 *   hygiene   f. ~/.claude/settings.json hash unchanged, every child process gone (always checked)
 * The lapse -> stop path of a budget pause (595 s) is not waited for here; it is covered by unit tests
 * (packages/core/src/runtime/huddle-core.budget.test.ts and detect/budget.test.ts; budget-runner.ts has no test file of its own).
 *
 * Safety
 *  - ~/.claude is never written. Hooks, the OTLP endpoint and the token travel in a per-run `--settings` temp file
 *    (harness-only RunLaunchOptions.settingsFile, ADR-020 s1), deleted afterwards. sha256 of ~/.claude/settings.json is taken before and after.
 *  - The Huddle listens on 127.0.0.1:<port> with a fresh random token, data dir under .huddle/m4/, throw-away claude config dir.
 *  - Claude runs in a git worktree of a temp repo (two or three tiny files, hooks off, no signing), not this repo.
 *  - The harness allows exactly one command (`node -e "console.log(1)"`); anything else that is asked is denied.
 * Evidence: .huddle/m4/exit-<date>/{events.jsonl, checks.json, summary.json, template.json, settings.redacted.json, git-*.txt}.
 * Local only (.huddle/ is git-ignored); may contain the prompt below, never the token.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/common.mjs';
import {
  assertSettingsUnchanged,
  buildRunSettings,
  checkBatch,
  checkModel,
  hashSettingsFile,
  maskSecrets,
  redactSettings,
  summarize,
  userSettingsPath,
} from './m3-exit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..');
export const DEFAULT_M4_PORT = 47941;
export const TEMPLATE_ID = 'm4-exit-team';
export const AGENT_NAMES = ['huddle-lister', 'huddle-reader', 'huddle-checker'];
/**
 * Picked from fixtures/runs/ (npm run eval:eta data): three-subagent runs there used about 135k to 150k tokens
 * (input + output + cache creation, 10 to 12 requests, 12k to 14k each). 60k trips after roughly four requests, a
 * third of the way in, which leaves most of the run to watch after the resume.
 */
export const TOKEN_BUDGET = 60000;
/** After the pause is seen, the budget is replaced by this one so the run can finish. */
export const RAISED_BUDGET = { scope: 'session', maxTokens: 50_000_000, warnAtFraction: 0.9, onExceed: 'notify' };
/** git status is Claude Code's own read-only set: it is never asked about, so no rule answers it (finding, run of 2026-11-14). */
export const GIT_STATUS_COMMAND = 'git status';
/**
 * Commands Claude Code may ask about that a default rule allows exactly (packages/core/src/policy/defaults.ts:
 * default:node-version, default:npm-version). The rules step fails unless at least one request was answered by a rule.
 */
export const SAFE_COMMANDS = ['node --version', 'npm --version'];
export const ASKED_COMMAND = 'node -e "console.log(1)"';
export const TELEMETRY_INTERVAL_MS = 2000;

export const STEPS = [
  { id: 'launch', title: 'a. a three-agent template is saved and launched into a worktree with a token budget' },
  { id: 'worktree', title: 'b. the worktree is under agent-huddle/worktrees/<runId> on huddle/<runId>; the root is managed there' },
  { id: 'rules', title: 'c. a safe command (`node --version`, `npm --version`) is allowed by a default rule with no inbox item; `node -e` is asked and allowed from the harness' },
  { id: 'budget', title: 'd. the budget pauses the run (exceed item, pause by the Huddle, a held tool call), then it is raised and resumed' },
  { id: 'discard', title: 'e. the run ends, the worktree is summarized and discarded from the app; folder and branch are gone' },
  { id: 'hygiene', title: 'f. ~/.claude/settings.json unchanged, no process left (always checked)' },
];

export function selectSteps(only) {
  if (!only) return STEPS;
  const ids = String(only).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !STEPS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown step id(s): ${unknown.join(', ')} (known: ${STEPS.map((s) => s.id).join(', ')})`);
  if (!ids.length) throw new Error('--only needs at least one step id');
  // launch and hygiene always run: nothing else exists without a launch, and the guard is never optional.
  return STEPS.filter((s) => ids.includes(s.id) || s.id === 'launch' || s.id === 'hygiene');
}

/** Per-run settings: the M3 hooks block plus the telemetry env, all pointing at the private port. No other env. */
export function buildM4Settings({ port, token }) {
  const { hooks } = buildRunSettings({ port, token });
  return {
    hooks,
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_EXPORTER_OTLP_HEADERS: `X-Huddle-Token=${token}`,
      OTEL_LOGS_EXPORT_INTERVAL: String(TELEMETRY_INTERVAL_MS),
    },
  };
}

export const PROMPT =
  'Use the Agent tool to start three subagents one after another: huddle-lister, huddle-reader and huddle-checker. ' +
  'Each of them must run the Bash commands `' + SAFE_COMMANDS[0] + '` and `' + SAFE_COMMANDS[1] + '` once each, as two separate Bash calls, and then report one short sentence. ' +
  'In addition huddle-lister must run the Bash command `' + GIT_STATUS_COMMAND + '` once and huddle-checker must run the Bash command `' + ASKED_COMMAND + '` once. ' +
  'Nobody may run any other command, and nobody may write or edit files. Wait for all three, then reply with one line per subagent.';

/** The template the scenario saves and launches. Pure. `budget: false` leaves the budget out. */
export function buildTemplate({ cwd, model, budget = true }) {
  const agent = (description, prompt) => ({ description, prompt, tools: ['Read', 'Grep', 'Glob', 'Bash'], ...(model ? { model } : {}) });
  return {
    id: TEMPLATE_ID,
    name: 'M4 exit team',
    description: 'Three read-only agents, used by npm run m4:exit.',
    prompt: PROMPT,
    cwd,
    mainAgent: null,
    model: model ?? null,
    permissionMode: 'default',
    agents: {
      'huddle-lister': agent('Lists the files in the folder.', 'You list files. Run only the commands you are told to run, then answer in one short sentence.'),
      'huddle-reader': agent('Reads one file.', 'You read files. Run only the commands you are told to run, then answer in one short sentence.'),
      'huddle-checker': agent('Runs the checks it is told to run.', 'You run checks. Run only the commands you are told to run, then answer in one short sentence.'),
    },
    ...(budget ? { budgets: [{ scope: 'session', maxTokens: TOKEN_BUDGET, warnAtFraction: 0.5, onExceed: 'pause' }] } : {}),
    worktree: true,
  };
}

/** The folder the Huddle keeps worktrees in: the same rule as defaultWorktreeDataDir in runtime/worktree.ts. */
export function defaultWorktreeBase(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'agent-huddle');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'agent-huddle');
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'agent-huddle');
}

/** Windows-safe path comparison: slashes, case and a trailing separator do not matter. */
export function samePath(a, b) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * May the harness ALLOW this request? Only the exact scripted command through Bash. The run's agents have the Bash tool,
 * so anything else asked (another command, a compound command, a write tool) is refused. Pure.
 */
export function judgeApproval(request) {
  const tool = request?.toolName;
  const command = request?.toolInput?.command;
  if (tool === 'Bash' && typeof command === 'string' && command.trim() === ASKED_COMMAND) return { ok: true, reason: '' };
  const shown = String(typeof command === 'string' ? command : request?.summary ?? '').replace(/\s+/g, ' ').slice(0, 120);
  return { ok: false, reason: `unexpected request: ${String(tool)} ${shown}`.trim() };
}

/** The Huddle's discard message when something still holds the worktree folder (Windows: EBUSY, EPERM, "Permission denied"). Pure. */
export function isBusyFailure(message) {
  return /EBUSY|EPERM|Permission denied|resource busy|being used by another process|locked/i.test(String(message ?? ''));
}

/**
 * Agents the Huddle paused for the budget, split into those still to resume and those whose subagent ended after the pause
 * (a pause cannot hold an agent that has finished: agent.resume answers "not paused" for it, seen 2026-11-14, run 2). Pure.
 */
export function splitPausedKeys(events) {
  const resume = [];
  const ended = [];
  const paused = events.filter((e) => e.type === 'control.applied' && e.action === 'pause' && e.source === 'huddle');
  for (const key of [...new Set(paused.map((e) => e.agentKey))]) {
    const since = Math.max(...paused.filter((e) => e.agentKey === key).map((e) => e.ts));
    (events.some((e) => e.type === 'agent.stopped' && e.agentKey === key && e.ts >= since) ? ended : resume).push(key);
  }
  return { resume, ended };
}

export function commandOf(request) {
  return typeof request?.toolInput?.command === 'string' ? request.toolInput.command.trim() : '';
}

// -------------------------------------------------------------------------------------------------------------------
// Evaluation: pure. Input is what happened (events of the run, command results, filesystem and git facts); output is checks.
// -------------------------------------------------------------------------------------------------------------------

const ofType = (events, type) => events.filter((e) => e.type === type);
const check = (name, pass, detail, extra = {}) => ({ name, pass: Boolean(pass), detail: detail ?? '', ...extra });
/** Reported, never a pass condition (a real finding the owner should read). */
const note = (name, detail) => check(name, true, detail, { note: true });

/** Tokens the way budgets count them (ADR-020 s4): input + output + cache creation, cache reads excluded. */
export function countedTokens(events) {
  return ofType(events, 'usage.recorded').reduce((s, e) => s + (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheCreationTokens || 0), 0);
}

/**
 * @param {{events: object[], runId: string|null, worktreeBase: string, steps: string[], facts: object}} input
 * facts: { templateResult, launchResult, agent, gitBefore: {folderExists, listed, branchExists}, gitAfter: same,
 *   answers: [{requestId, command, verdict:'allow'|'deny', ok}], discardResult, pausedKeys: string[], resumeResults: [], raiseResult }
 * @returns {Record<string, {name: string, pass: boolean, detail: string, note?: boolean}[]>}
 */
export function evaluateExit({ events, runId, worktreeBase, steps, facts }) {
  const out = {};
  const want = (id) => steps.includes(id);
  const answers = facts.answers ?? [];
  const requested = ofType(events, 'approval.requested');
  const resolved = ofType(events, 'approval.resolved');

  if (want('launch')) {
    const launched = ofType(events, 'run.launched')[0];
    const budgetSet = ofType(events, 'budget.set').find((e) => e.budget?.maxTokens === TOKEN_BUDGET);
    out.launch = [
      check('template.upsert accepted', facts.templateResult?.ok === true, facts.templateResult ? (facts.templateResult.ok ? 'ok' : facts.templateResult.message) : 'not sent'),
      check('run.launch accepted and returned the run id', facts.launchResult?.ok === true && Boolean(runId), facts.launchResult?.ok ? String(runId) : String(facts.launchResult?.message ?? 'not sent')),
      check('run.launched names the three agents, permission mode default', launched && AGENT_NAMES.every((n) => launched.agentNames?.includes(n)) && launched.agentNames.length === 3 && launched.permissionMode === 'default', launched ? `${launched.agentNames?.join(',')} / ${launched.permissionMode}` : 'no run.launched'),
      check('a token budget with action pause is in force', budgetSet?.budget?.onExceed === 'pause' && budgetSet?.scope === 'session', budgetSet ? `${budgetSet.budget.maxTokens} tokens, ${budgetSet.budget.onExceed}` : 'no budget.set'),
      check('hooks reached the Huddle from the run (a subagent started)', ofType(events, 'agent.started').length >= 1, `${ofType(events, 'agent.started').length} agent.started`),
    ];
  }

  if (want('worktree')) {
    const created = ofType(events, 'worktree.created')[0];
    const expectedPath = runId ? path.join(worktreeBase, 'worktrees', runId) : '';
    const gb = facts.gitBefore ?? {};
    out.worktree = [
      check('worktree.created path is <base>/worktrees/<runId>', created && runId && samePath(created.path, expectedPath), created ? `${created.path} (expected ${expectedPath})` : 'no worktree.created'),
      check('branch is huddle/<runId>', created && runId && created.branch === `huddle/${runId}`, created?.branch ?? 'no worktree.created'),
      check('the folder exists and git lists it as a worktree of the repo', gb.folderExists === true && gb.listed === true, `folder:${String(gb.folderExists)} listed:${String(gb.listed)}`),
      check('the branch exists in the repo', gb.branchExists === true, String(gb.branchExists)),
      check('the root agent is managed and its session folder is the worktree', facts.agent?.origin === 'managed' && created && samePath(facts.agent?.sessionCwd ?? '', created.path), facts.agent ? `${String(facts.agent.origin)} / ${String(facts.agent.sessionCwd)}` : 'no agent'),
    ];
  }

  if (want('rules')) {
    const policy = resolved.filter((e) => e.by === 'policy' && String(e.policyRuleId ?? '').startsWith('default:'));
    const isGitStatus = (e) => /^git status(\s|$)/.test(commandOf(e.request));
    const resolutionOf = (e) => resolved.find((r) => r.requestId === e.request?.requestId);
    // A rule-answered request still writes approval.requested, then approval.resolved by policy at once (inbox never shows it).
    const byRule = (e) => { const r = resolutionOf(e); return r?.by === 'policy' && String(r.policyRuleId ?? '').startsWith('default:') && r.ts - e.ts < 1000; };
    const gitRule = requested.filter((e) => isGitStatus(e) && byRule(e));
    const gitWaited = requested.filter((e) => isGitStatus(e) && !byRule(e));
    const safeAsked = requested.filter((e) => SAFE_COMMANDS.includes(commandOf(e.request)));
    const safeByRule = safeAsked.filter(byRule);
    const safeWaited = safeAsked.filter((e) => !byRule(e));
    const ruleIds = [...new Set(policy.map((e) => e.policyRuleId))].join(', ');
    const nodeAsked = requested.filter((e) => commandOf(e.request) === ASKED_COMMAND);
    const nodeAnswer = answers.find((a) => a.command === ASKED_COMMAND);
    const nodeResolved = nodeAsked.length ? resolved.find((e) => e.requestId === nodeAsked[0].request.requestId) : undefined;
    const bashFinished = ofType(events, 'tool.finished').filter((e) => e.toolName === 'Bash');
    out.rules = [
      note('git status: how many requests a default rule answered', gitRule.length === 0 && gitWaited.length === 0 ? 'none: Claude Code did not ask about git status (its own read-only set), so no rule answered it; the rules step relies on the version commands instead' : `${gitRule.length} by rule, ${gitWaited.length} waited for a person`),
      check('at least one request was answered by a default rule (approve by rule exercised for real)', policy.length >= 1 && safeByRule.length >= 1, policy.length ? `${policy.length} by ${ruleIds}; safe version commands asked ${safeAsked.length}, by rule ${safeByRule.length}` : `no request was answered by a rule; safe version commands asked: ${safeAsked.length}. If Claude Code never asks about them, the default set only covers commands it already lets through`),
      check('no safe command waited for a person (each was answered by a default rule within 1 s)', safeWaited.length === 0 && gitWaited.length === 0, safeWaited.length + gitWaited.length ? `${safeWaited.length + gitWaited.length} safe request(s) were not answered by a default rule` : `${safeAsked.length + gitRule.length} safe request(s), all by rule`),
      check('the non-default command (node -e) appeared in the inbox', nodeAsked.length >= 1, `${nodeAsked.length} request(s)`),
      check('the harness allowed it with approval.decide and the Huddle accepted', nodeAnswer?.verdict === 'allow' && nodeAnswer?.ok === true, nodeAnswer ? `${nodeAnswer.verdict} ok:${String(nodeAnswer.ok)}` : 'no answer sent'),
      check('it resolved allowed by the user', nodeResolved?.outcome === 'allowed' && nodeResolved?.by === 'user', nodeResolved ? `${nodeResolved.outcome} by ${nodeResolved.by}` : 'no approval.resolved'),
      check('the command ran (a Bash tool.finished after the answer)', nodeResolved !== undefined && bashFinished.some((e) => e.ts >= nodeResolved.ts), `${bashFinished.length} Bash finish(es)`),
      note('other requests the harness denied', answers.filter((a) => a.verdict === 'deny').map((a) => a.command || '(not a command)').join(' | ') || 'none'),
    ];
  }

  if (want('budget')) {
    const over = ofType(events, 'attention.raised').find((e) => e.item?.kind === 'budget' && /used up/i.test(e.item?.title ?? ''));
    const pauses = ofType(events, 'control.applied').filter((e) => e.action === 'pause');
    const holdStarted = ofType(events, 'hold.started')[0];
    const holdEnded = ofType(events, 'hold.ended')[0];
    const counted = countedTokens(events);
    const huddlePause = pauses.find((e) => e.source === 'huddle');
    out.budget = [
      check('an exceed item appeared (kind budget, "used up")', over !== undefined, over ? over.item.title : 'no budget item with "used up"'),
      check('counted tokens reached the budget when it tripped', counted >= TOKEN_BUDGET, `${counted} counted tokens in total, budget ${TOKEN_BUDGET}`),
      check('control.applied pause with source huddle', huddlePause !== undefined, huddlePause ? `source ${huddlePause.source}, ${pauses.length} pause(s)` : `${pauses.length} pause(s), none from the Huddle`),
      check('a PreToolUse was held after the pause (hold.started)', holdStarted !== undefined && (!huddlePause || holdStarted.ts >= huddlePause.ts), holdStarted ? 'held' : 'no hold.started (the run may have finished before its next tool call)'),
      check('the budget was raised and the paused agents resumed', facts.raiseResult?.ok === true && (facts.resumeResults ?? []).length >= 1 && (facts.resumeResults ?? []).every((r) => r.ok), `raise:${String(facts.raiseResult?.ok)} resumed:${(facts.resumeResults ?? []).filter((r) => r.ok).length}/${(facts.resumeResults ?? []).length}`),
      check('the hold ended because of the resume', holdEnded?.why === 'resumed', holdEnded ? holdEnded.why : 'no hold.ended'),
      check('the run carried on to a result after the resume', ofType(events, 'run.result').length >= 1 && ofType(events, 'run.result').some((e) => !huddlePause || e.ts >= huddlePause.ts), `${ofType(events, 'run.result').length} run.result`),
      note('paused agents that ended before the resume (nothing left to resume)', (facts.endedWhilePaused ?? []).length ? facts.endedWhilePaused.join(', ') : 'none'),
      note('lapse -> stop path', 'a budget pause that reaches the 595 s hold limit stops a managed run; covered by unit tests, not waited for here'),
    ];
  }

  if (want('discard')) {
    const exited = ofType(events, 'run.exited')[0];
    const summary = ofType(events, 'worktree.summarized')[0];
    const closed = ofType(events, 'worktree.closed')[0];
    const ga = facts.gitAfter ?? {};
    out.discard = [
      check('run.exited (how completed, exit code 0) after run.end', exited?.how === 'completed' && exited?.exitCode === 0, exited ? `${exited.how}, exit ${String(exited.exitCode)}` : 'no run.exited'),
      check('worktree.summarized is present', summary !== undefined, summary ? `${summary.filesChanged} changed, ${summary.untracked} untracked` : 'no worktree.summarized'),
      check('run.discardWorktree accepted', facts.discardResult?.ok === true, facts.discardResult ? (facts.discardResult.ok ? 'ok' : facts.discardResult.message) : 'not sent'),
      check('worktree.closed discarded without error', closed?.outcome === 'discarded' && !closed?.error, closed ? `${closed.outcome}${closed.error ? `: ${closed.error}` : ''}` : 'no worktree.closed'),
      check('the folder is gone', ga.folderExists === false, String(ga.folderExists)),
      check('git worktree list no longer lists it', ga.listed === false, String(ga.listed)),
      check('git branch --list no longer shows the branch', ga.branchExists === false, String(ga.branchExists)),
      note('discard retries because the folder was in use', facts.discardRetries ? `${facts.discardRetries} retry(ies) after a busy folder (a process started by a plugin hook at SessionEnd held it)` : 'none needed'),
      note('what the "changed" files were (top folders of worktree.summarized)', summary?.files ? [...new Set(summary.files.map((f) => String(f.path).split('/').slice(0, 2).join('/')))].join(', ') || 'none' : 'no list'),
    ];
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------------------
// Dry run
// -------------------------------------------------------------------------------------------------------------------

export function evidenceDirName(now = new Date()) {
  return `exit-${now.toISOString().slice(0, 10)}`;
}

export function planFromArgs(args, now = new Date()) {
  return { execute: !args['dry-run'] && args.yes === true, batch: checkBatch(args.batch ?? evidenceDirName(now)) };
}

export function describePlan({ steps, port, batch, model, worktreeBase, log }) {
  log(`Dry run: nothing is executed, no process is started, no file is written. ${steps.length} step(s), one real claude run when started with --yes.`);
  log(`Evidence would go to .huddle/m4/${batch}/. Huddle: 127.0.0.1:${port}, fresh token, data dir .huddle/m4/${batch}/data.`);
  log(`Guard: sha256 of ${userSettingsPath()} before and after (now: ${hashSettingsFile(userSettingsPath()).slice(0, 12)}); a change fails the run.`);
  log('Per-run settings file (temp, deleted afterwards; token shown as <token>):');
  log(JSON.stringify(redactSettings(buildM4Settings({ port, token: '<token>' }), '<token>'), null, 2));
  log(`Model: ${model ?? '(claude default, no --model flag)'}`);
  log(`Temp git repo (hooks off, no signing) with a commit and a few files; the template's cwd. Worktrees under ${path.join(worktreeBase, 'worktrees')}<runId>.`);
  log('Template (agents, budget, flags):');
  log(JSON.stringify(buildTemplate({ cwd: '<temp repo>', model }), null, 2));
  log(`Launch: the Huddle spawns claude -p --input-format stream-json --output-format stream-json --verbose --session-id <runId> --permission-mode default --agents <file> --settings <per-run file> [--model ${model ?? '-'}] in the worktree; the prompt goes over stdin.`);
  log('Steps:');
  for (const s of steps) log(`  ${s.id.padEnd(9)} ${s.title}`);
  log(`Huddle-side actions: approval.decide allow only for \`${ASKED_COMMAND}\` (everything else asked is denied); on the budget exceed item: budget.set raising the session budget to ${RAISED_BUDGET.maxTokens} (notify), then agent.resume for each paused agent; after run.result: run.end; run.discardWorktree.`);
  log(`Budget: ${TOKEN_BUDGET} tokens (input+output+cache creation), action pause. Chosen from fixtures/runs/ (three-subagent runs used 135k to 150k); it trips about a third of the way through.`);
  log('Cost: one managed run with three subagents, about 10 model calls. Re-run with --yes to start (ask the owner first).');
}

// -------------------------------------------------------------------------------------------------------------------
// Real runs
// -------------------------------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts the headless Huddle child (scripts/lib/m4-host.mjs). Resolves a handle; rejects if it is not ready in 40 s. */
export function startHost({ port, token, dataDir, claudeDir, settingsFile, claudeCommand, worktreeDir, onEvents }) {
  return new Promise((resolve, reject) => {
    const argv = [path.join(here, 'lib', 'm4-host.mjs'), '--port', String(port), '--data-dir', dataDir, '--claude-dir', claudeDir, '--settings-file', settingsFile];
    if (claudeCommand) argv.push('--claude-command', claudeCommand);
    if (worktreeDir) argv.push('--worktree-dir', worktreeDir);
    const child = spawn(process.execPath, argv, { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    child.stdin.write(token + '\n'); // the token never travels in argv
    let stderr = '';
    let settled = false;
    let exited = false;
    const pending = new Map();
    const ask = (payload) => {
      const id = crypto.randomUUID();
      return new Promise((res) => {
        pending.set(id, res);
        child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
        setTimeout(() => { if (pending.delete(id)) res({ ok: false, code: 'failed', message: 'host did not answer' }); }, 20000);
      });
    };
    const handle = {
      pid: child.pid,
      get exited() { return exited; },
      command: (command, sessionId) => ask({ op: 'command', command, sessionId }),
      agent: (sessionId) => ask({ op: 'agent', sessionId }),
      kill() {
        if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      },
      async dispose() {
        if (exited) return;
        try { child.stdin.write('{"op":"dispose"}\n'); } catch { /* already gone */ }
        await Promise.race([new Promise((r) => child.once('exit', r)), sleep(12000)]);
        if (!exited) handle.kill();
      },
    };
    const timer = setTimeout(() => { if (!settled) { settled = true; handle.kill(); reject(new Error(`Huddle host did not start in 40 s: ${stderr.slice(0, 500)}`)); } }, 40000);
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

/** git with an args array and no shell; hooks off, no signing, no prompts. Returns { ok, stdout, stderr }. */
export function git(cwd, args, { quiet = false } = {}) {
  const r = spawnSync('git', ['-c', `core.hooksPath=${path.join(os.tmpdir(), 'huddle-m4-no-such-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status !== 0 && !quiet) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr).slice(0, 300)}`);
  return { ok: r.status === 0, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

/** A temp git repo with one commit and a few files, hooks off and signing off in its own config too. */
export function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-m4-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Huddle M4 exit']);
  git(dir, ['config', 'user.email', 'm4-exit@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.hooksPath', path.join(os.tmpdir(), 'huddle-m4-no-such-hooks')]);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'm4-scratch-project', version: '0.0.1', private: true }, null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), '# M4 scratch project\n\nA folder for the Agent Huddle M4 exit checks.\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export const answer = 42;\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'one\ntwo\nthree\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial commit']);
  return dir;
}

/** What git says about a worktree path and branch, from the repo. */
export function gitFacts(repo, worktreePath, branch) {
  const list = git(repo, ['worktree', 'list', '--porcelain'], { quiet: true }).stdout;
  const listed = list.split(/\r?\n/).some((l) => l.startsWith('worktree ') && samePath(l.slice('worktree '.length), worktreePath));
  const branches = git(repo, ['branch', '--list', branch], { quiet: true }).stdout.trim();
  return { folderExists: fs.existsSync(worktreePath), listed, branchExists: branches !== '', worktreeList: list.trim(), branchList: branches };
}

/** Pids of processes whose command line contains `needle` (a run id), not counting this probe. Never throws. */
export function processesMatching(needle) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${needle}*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000 });
      return String(r.stdout).split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number);
    }
    const r = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', shell: false });
    return String(r.stdout).split('\n').filter((l) => l.includes(needle) && !l.includes('ps -eo')).map((l) => Number(l.trim().split(/\s+/)[0])).filter(Number.isFinite);
  } catch {
    return [];
  }
}

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

/**
 * The whole scenario. Resolves { steps, checks, error, ... } and writes the evidence folder. Everything it starts is
 * stopped in `finally`.
 */
export async function runExit({ steps, port, batchDir, timeoutMs, model, claudeCommand, worktreeDir, log }) {
  fs.mkdirSync(batchDir, { recursive: true });
  const stepIds = steps.map((s) => s.id);
  const token = crypto.randomBytes(24).toString('base64url');
  const settings = buildM4Settings({ port, token });
  const settingsFile = path.join(os.tmpdir(), `huddle-m4-${crypto.randomUUID()}.json`);
  const worktreeBase = worktreeDir ?? defaultWorktreeBase();
  const events = [];
  const waitFor = makeWaiter(events);
  const notes = [];
  const say = (m) => { notes.push(m); log(`[m4] ${m}`); };
  const facts = { answers: [], resumeResults: [] };
  const result = { error: null, runId: null, steps: stepIds, checks: {} };
  let host = null;
  let repo = null;
  let sessionId = null;
  let done = false;
  let onExit = () => undefined;
  const onSignal = () => { onExit(); process.exit(130); };
  const own = (e) => sessionId !== null && (e.sessionId === sessionId || e.runId === sessionId);
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
    onExit = () => { fs.rmSync(settingsFile, { force: true }); host?.kill(); if (repo) fs.rmSync(repo, { recursive: true, force: true }); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    fs.writeFileSync(path.join(batchDir, 'settings.redacted.json'), JSON.stringify(redactSettings(settings, token), null, 2));
    repo = makeRepo();
    const template = buildTemplate({ cwd: repo, model, budget: stepIds.includes('budget') });
    fs.writeFileSync(path.join(batchDir, 'template.json'), JSON.stringify(template, null, 2));
    host = await startHost({
      port, token, settingsFile, claudeCommand, worktreeDir,
      dataDir: path.join(batchDir, 'data'),
      claudeDir: path.join(batchDir, 'claude-config-throwaway'),
      onEvents: (batch) => { for (const e of batch) if (own(e) || sessionId === null) events.push(e); },
    });
    say(`Huddle up on 127.0.0.1:${port}; repo ${repo}`);

    // a. template and launch
    facts.templateResult = await host.command({ type: 'template.upsert', template });
    if (!facts.templateResult.ok) throw new Error(`template.upsert failed: ${facts.templateResult.message}`);
    facts.launchResult = await host.command({ type: 'run.launch', templateId: TEMPLATE_ID });
    if (!facts.launchResult.ok) throw new Error(`run.launch failed: ${facts.launchResult.message}`);
    result.runId = sessionId = String(facts.launchResult.detail);
    say(`launched run ${sessionId}`);
    // events that arrived before the id was known belong to this run only if they name it
    for (let i = events.length - 1; i >= 0; i--) if (!own(events[i])) events.splice(i, 1);

    // The approval handler runs for the whole run: it answers what the inbox gets (ending 1) and records it.
    const seen = new Set();
    const firstSeen = new Map();
    const handler = (async () => {
      while (!done) {
        for (const e of events) {
          if (e.type !== 'approval.requested' || seen.has(e.request.requestId)) continue;
          // a rule answers within milliseconds; only a request still open after a moment is the harness's to answer
          if (events.some((r) => r.type === 'approval.resolved' && r.requestId === e.request.requestId)) { seen.add(e.request.requestId); continue; }
          if (!firstSeen.has(e.request.requestId)) firstSeen.set(e.request.requestId, Date.now());
          if (Date.now() - firstSeen.get(e.request.requestId) < 400) continue;
          seen.add(e.request.requestId);
          const verdict = judgeApproval(e.request);
          const command = commandOf(e.request) || String(e.request.summary ?? '');
          const decision = verdict.ok
            ? { type: 'approval.decide', requestId: e.request.requestId, decision: 'allow' }
            : { type: 'approval.decide', requestId: e.request.requestId, decision: 'deny', message: 'Agent Huddle M4 check: this is not the command the check expects. Do not run it.' };
          say(`${verdict.ok ? 'allow' : 'deny'} ${e.request.requestId}: ${command.slice(0, 80)}`);
          const res = await host.command(decision, sessionId);
          facts.answers.push({ requestId: e.request.requestId, command, verdict: verdict.ok ? 'allow' : 'deny', ok: res.ok === true });
        }
        await sleep(100);
      }
    })();

    if (stepIds.includes('worktree')) {
      const created = await waitFor('worktree.created', (ev) => ev.find((e) => e.type === 'worktree.created'), 30000);
      facts.agent = await host.agent(sessionId);
      facts.gitBefore = gitFacts(repo, created.path, created.branch);
      facts.worktreePath = created.path;
      facts.branch = created.branch;
    }

    // d. the budget
    if (stepIds.includes('budget')) {
      await waitFor('the budget exceed item (kind budget, "used up")', (ev) => ev.find((e) => e.type === 'attention.raised' && e.item?.kind === 'budget' && /used up/i.test(e.item?.title ?? '')), timeoutMs);
      say('budget exceeded; waiting for a held tool call');
      await waitFor('a pause by the Huddle', (ev) => ev.find((e) => e.type === 'control.applied' && e.action === 'pause' && e.source === 'huddle'), 60000);
      await waitFor('hold.started (the next PreToolUse held)', (ev) => ev.find((e) => e.type === 'hold.started'), 180000).catch((err) => { say(String(err.message)); });
      // Raise first so the resumed agents do not trip it again, then resume every agent the Huddle paused.
      facts.raiseResult = await host.command({ type: 'budget.set', agentKey: '$MAIN', budget: RAISED_BUDGET }, sessionId);
      const { resume: keys, ended } = splitPausedKeys(events);
      facts.endedWhilePaused = ended;
      for (const key of keys) facts.resumeResults.push(await host.command({ type: 'agent.resume', agentKey: key }));
      say(`budget raised (${facts.raiseResult.ok}); resumed ${keys.length} agent(s)${ended.length ? `; ${ended.length} paused agent(s) had already ended (nothing to resume)` : ''}`);
    }

    // the turn ends, then the run is ended from the app (closes stdin: "end" = close stdin, S16 b)
    await waitFor('the run result (the turn finished)', (ev) => ev.find((e) => e.type === 'run.result'), timeoutMs);
    await host.command({ type: 'run.end', runId: sessionId }, sessionId);
    await waitFor('run.exited', (ev) => ev.find((e) => e.type === 'run.exited'), 60000);
    await waitFor('worktree.summarized', (ev) => ev.find((e) => e.type === 'worktree.summarized'), 60000).catch((err) => { say(String(err.message)); });

    // e. discard
    if (stepIds.includes('discard')) {
      facts.discardResult = await host.command({ type: 'run.discardWorktree', runId: sessionId }, sessionId);
      // A process the user's own plugins start at SessionEnd (e.g. a detached session-end job) can hold the worktree folder
      // for a few seconds after run.exited (seen 2026-11-14: "Permission denied" / EBUSY). The owner would press Discard again,
      // so the harness does too, up to three more times 6 s apart, and says so. The Huddle's discard is safe to repeat.
      for (let attempt = 1; attempt <= 3 && !facts.discardResult.ok && isBusyFailure(facts.discardResult.message); attempt++) {
        say(`discard failed because the folder is in use (${String(facts.discardResult.message).slice(0, 120)}); retry ${attempt} in 6 s`);
        await sleep(6000);
        facts.discardResult = await host.command({ type: 'run.discardWorktree', runId: sessionId }, sessionId);
        facts.discardRetries = attempt;
      }
      if (facts.discardResult.ok) await waitFor('worktree.closed', (ev) => ev.find((e) => e.type === 'worktree.closed'), 60000);
      if (facts.worktreePath) facts.gitAfter = gitFacts(repo, facts.worktreePath, facts.branch);
    }
  } catch (err) {
    result.error = String(err?.message ?? err);
    say(`stopped: ${result.error}`);
  } finally {
    done = true;
    result.checks = evaluateExit({ events, runId: result.runId, worktreeBase, steps: stepIds, facts });
    // Whatever the run left behind is cleaned so a failed run does not leak a worktree: only a worktree this run made, via the app command.
    if (host && !host.exited && sessionId && !facts.discardResult?.ok && ofType(events, 'worktree.created').length > 0 && ofType(events, 'worktree.closed').length === 0) {
      await host.command({ type: 'run.stop', runId: sessionId }, sessionId).catch(() => null);
      await waitFor('run.exited', (ev) => ev.find((e) => e.type === 'run.exited'), 15000).catch(() => null);
      const r = await host.command({ type: 'run.discardWorktree', runId: sessionId }, sessionId).catch(() => null);
      if (r) say(`cleanup discard: ${r.ok ? 'ok' : r.message}`);
    }
    if (host) await host.dispose();
    fs.rmSync(settingsFile, { force: true });
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // f. hygiene (after the host is gone)
    // Detached plugin jobs that name the run end by themselves a few seconds after SessionEnd: give them up to 20 s.
    let leftovers = result.runId ? processesMatching(result.runId) : [];
    for (let i = 0; i < 10 && leftovers.length > 0; i++) { await sleep(2000); leftovers = processesMatching(result.runId); }
    result.hygieneFacts = { leftovers, hostExited: host ? host.exited : true };
    result.notes = notes;
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    fs.writeFileSync(path.join(batchDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  }
  return result;
}

export async function runAll({ steps, port, batch, timeoutMs, model, claudeCommand, worktreeDir, root = REPO, log = console.log }) {
  const batchDir = path.join(root, '.huddle', 'm4', checkBatch(batch));
  fs.mkdirSync(batchDir, { recursive: true });
  const settingsFile = userSettingsPath();
  const before = hashSettingsFile(settingsFile);
  const summary = { batch, started: new Date().toISOString(), userSettingsHashBefore: before, steps: steps.map((s) => s.id), checks: {}, error: null };
  try {
    const r = await runExit({ steps, port, batchDir, timeoutMs, model, claudeCommand, worktreeDir, log });
    summary.runId = r.runId;
    summary.error = r.error;
    summary.checks = r.checks;
    summary.notes = r.notes;
    summary.hygieneFacts = r.hygieneFacts;
  } finally {
    summary.ended = new Date().toISOString();
    summary.userSettingsHashAfter = hashSettingsFile(settingsFile);
    const h = summary.hygieneFacts ?? { leftovers: [], hostExited: true };
    summary.checks.hygiene = [
      check('~/.claude/settings.json is byte-for-byte unchanged', before === summary.userSettingsHashAfter, `${before.slice(0, 12)} before, ${summary.userSettingsHashAfter.slice(0, 12)} after`),
      check('no process left whose command line names the run', h.leftovers.length === 0, h.leftovers.length ? `pids ${h.leftovers.join(',')}` : 'none'),
      check('the headless Huddle process exited', h.hostExited === true, String(h.hostExited)),
    ];
    for (const [id, list] of Object.entries(summary.checks)) {
      for (const c of list) c.detail = maskSecrets(c.detail);
      void id;
    }
    fs.writeFileSync(path.join(batchDir, 'checks.json'), JSON.stringify(summary.checks, null, 2));
    fs.writeFileSync(path.join(batchDir, 'summary.json'), JSON.stringify(summary, null, 2));
  }
  report(summary, log);
  assertSettingsUnchanged(before, summary.userSettingsHashAfter, settingsFile);
  log(`${settingsFile} unchanged (sha256 ${before.slice(0, 12)}).`);
  return summary;
}

/** Prints each step's checks. */
export function report(summary, log) {
  if (summary.error) log(`Stopped early: ${summary.error}`);
  for (const step of STEPS) {
    const list = summary.checks[step.id];
    if (!list) { if (summary.steps.includes(step.id) === false) log(`[${step.id}] skipped`); continue; }
    const s = summarize(list);
    log(`[${step.id}] ${s.failed === 0 && !(summary.error && list.length === 0) ? 'PASS' : 'FAIL'} (${s.passed} ok, ${s.failed} failed) ${step.title}`);
    for (const c of list) log(`    ${c.note ? 'note' : c.pass ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` -- ${c.detail}` : ''}`);
  }
}

/** True when every check of every step passed and nothing stopped the run early. */
export function allPassed(summary) {
  if (summary.error) return false;
  return Object.values(summary.checks).every((list) => list.every((c) => c.pass));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ['yes', 'dry-run', 'help'], values: ['only', 'port', 'batch', 'timeout-min', 'model', 'claude-command', 'worktree-dir'] });
  if (args.help || args.unknown.length) {
    console.log('usage: node scripts/m4-exit.mjs [--dry-run] [--yes] [--only launch,worktree,rules,budget,discard] [--port 47941] [--batch <name>] [--model sonnet] [--timeout-min 10]\nWithout --yes it is a dry run (also with --only). --yes starts a real claude run: ask the owner first.');
    process.exit(args.unknown.length ? 1 : 0);
  }
  const steps = selectSteps(args.only);
  const port = Number(args.port ?? DEFAULT_M4_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an integer from 1024 to 65535');
  const model = checkModel(args.model ?? 'sonnet');
  const timeoutMs = Number(args['timeout-min'] ?? 10) * 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 60000) throw new Error('--timeout-min must be at least 1');
  const { execute, batch } = planFromArgs(args);
  const worktreeDir = args['worktree-dir'] ? path.resolve(args['worktree-dir']) : undefined;
  if (!execute) return describePlan({ steps, port, batch, model, worktreeBase: worktreeDir ?? defaultWorktreeBase(), log: console.log });
  const summary = await runAll({ steps, port, batch, timeoutMs, model, worktreeDir, claudeCommand: args['claude-command'] ? path.resolve(args['claude-command']) : undefined });
  console.log(`Done. Evidence: .huddle/m4/${batch}/ (summary.json). ${allPassed(summary) ? 'All checks passed.' : 'Some checks failed.'}`);
  if (!allPassed(summary)) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(String(err?.message ?? err)); process.exit(2); });
}
