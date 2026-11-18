import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AGENT_NAMES,
  ASKED_COMMAND,
  STEPS,
  TOKEN_BUDGET,
  allPassed,
  buildM4Settings,
  buildTemplate,
  countedTokens,
  defaultWorktreeBase,
  evaluateExit,
  isBusyFailure,
  judgeApproval,
  planFromArgs,
  runAll,
  samePath,
  selectSteps,
  splitPausedKeys,
} from './m4-exit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'm4-exit.mjs');
const FAKE = path.join(here, 'lib', 'm4-fake-claude.mjs');

test('settings: M3 hooks plus telemetry env, everything on the private port, token only in headers', () => {
  const s = buildM4Settings({ port: 47941, token: 'tok-abcdefgh' });
  assert.equal(s.hooks.PreToolUse[0].hooks[0].url, 'http://127.0.0.1:47941/huddle/hooks/PreToolUse');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].timeout, 600);
  assert.equal(s.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://127.0.0.1:47941');
  assert.equal(s.env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  assert.match(s.env.OTEL_EXPORTER_OTLP_HEADERS, /^X-Huddle-Token=tok-abcdefgh$/);
  assert.deepEqual(Object.keys(s.env).filter((k) => !k.startsWith('OTEL_') && k !== 'CLAUDE_CODE_ENABLE_TELEMETRY'), []);
});

test('template: three read-only agents, worktree on, default permission mode, a pause budget; the prompt is not on the command line', () => {
  const t = buildTemplate({ cwd: 'C:/x', model: 'sonnet' });
  assert.deepEqual(Object.keys(t.agents), AGENT_NAMES);
  for (const a of Object.values(t.agents)) {
    assert.ok(!a.tools.some((n) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'].includes(n)), 'no write or web tools');
  }
  assert.equal(t.worktree, true);
  assert.equal(t.permissionMode, 'default');
  assert.deepEqual(t.budgets, [{ scope: 'session', maxTokens: TOKEN_BUDGET, warnAtFraction: 0.5, onExceed: 'pause' }]);
  assert.equal(buildTemplate({ cwd: 'C:/x', model: 'sonnet', budget: false }).budgets, undefined);
});

test('the budget is picked from the recorded three-subagent runs: below a typical total, above one request', () => {
  const dir = path.join(here, '..', 'fixtures', 'runs');
  const counted = (file) => {
    let total = 0;
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.includes('api_request')) continue;
      const rec = JSON.parse(line);
      for (const rl of rec.payload?.resourceLogs ?? []) for (const sl of rl.scopeLogs) for (const r of sl.logRecords) {
        const a = Object.fromEntries(r.attributes.map((x) => [x.key, Number(Object.values(x.value)[0])]));
        if (r.attributes.some((x) => x.key === 'event.name' && x.value.stringValue === 'api_request')) total += (a.input_tokens || 0) + (a.output_tokens || 0) + (a.cache_creation_tokens || 0);
      }
    }
    return total;
  };
  for (const f of ['seq-list-3.jsonl', 'par-summarize-3.jsonl', 'nested-chain-3.jsonl']) {
    const total = counted(f);
    assert.ok(total > TOKEN_BUDGET * 1.5, `${f}: ${total} tokens, the budget ${TOKEN_BUDGET} must trip well before the end`);
  }
});

test('judgeApproval allows only the exact node -e command through Bash', () => {
  const req = (toolName, command) => ({ toolName, toolInput: { command } });
  assert.equal(judgeApproval(req('Bash', ASKED_COMMAND)).ok, true);
  assert.equal(judgeApproval(req('Bash', `  ${ASKED_COMMAND}  `)).ok, true);
  for (const bad of [
    req('Bash', `${ASKED_COMMAND} && rm -rf .`),
    req('Bash', 'node -e "console.log(2)"'),
    req('Bash', 'git push'),
    req('Write', ASKED_COMMAND),
    { toolName: 'Bash', toolInput: {} },
    undefined,
  ]) assert.equal(judgeApproval(bad).ok, false, JSON.stringify(bad));
});

test('steps: --only narrows but launch and hygiene always stay; unknown ids are refused', () => {
  assert.equal(selectSteps(undefined).length, STEPS.length);
  assert.deepEqual(selectSteps('rules').map((s) => s.id), ['launch', 'rules', 'hygiene']);
  assert.throws(() => selectSteps('rules,nope'), /Unknown step id\(s\): nope/);
  assert.throws(() => selectSteps(','), /at least one/);
});

test('real runs need --yes; --dry-run wins; batch names are plain', () => {
  assert.equal(planFromArgs({ unknown: [] }).execute, false);
  assert.equal(planFromArgs({ yes: true, 'dry-run': true }).execute, false);
  assert.equal(planFromArgs({ yes: true }).execute, true);
  assert.equal(planFromArgs({}, new Date('2026-11-14T10:00:00Z')).batch, 'exit-2026-11-14');
  assert.throws(() => planFromArgs({ batch: '../x' }), /Invalid --batch/);
});

test('worktree base follows the Huddle rule: %LOCALAPPDATA%/agent-huddle on Windows', () => {
  assert.equal(defaultWorktreeBase({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\agent-huddle');
  assert.equal(defaultWorktreeBase({}, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\agent-huddle');
  assert.ok(samePath('C:\\A\\b\\', 'c:/a/b'));
});

test('the dry run prints the plan and starts nothing (no evidence folder, no process)', () => {
  const before = fs.existsSync(path.join(here, '..', '.huddle', 'm4'));
  const r = spawnSync(process.execPath, [SCRIPT, '--only', 'rules'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run: nothing is executed/);
  assert.match(r.stdout, /huddle-lister/);
  assert.match(r.stdout, /--permission-mode default/);
  assert.ok(!r.stdout.includes('"X-Huddle-Token": "' + 'a'), 'the token is shown as <token>');
  assert.match(r.stdout, /<token>/);
  assert.equal(fs.existsSync(path.join(here, '..', '.huddle', 'm4')), before);
  const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});

// --- evaluation: a failing step must say so -----------------------------------------------------------------------------

const ev = (type, ts, extra = {}) => ({ type, ts, ...extra });
const names = (list) => (list ?? []).filter((c) => !c.pass).map((c) => c.name);

test('rules: FAILS unless a default rule answered a request; a safe command that waited for a person fails; git status is only a note', () => {
  const rule = [ev('approval.requested', 0, { request: { requestId: 'r1', toolName: 'Bash', toolInput: { command: 'node --version' } } }), ev('approval.resolved', 1, { requestId: 'r1', by: 'policy', outcome: 'allowed', policyRuleId: 'default:node-version' })];
  const node = [
    ev('approval.requested', 2, { request: { requestId: 'r2', toolName: 'Bash', toolInput: { command: ASKED_COMMAND } } }),
    ev('approval.resolved', 3, { requestId: 'r2', by: 'user', outcome: 'allowed' }),
    ev('tool.finished', 4, { toolName: 'Bash' }),
  ];
  const facts = { answers: [{ requestId: 'r2', command: ASKED_COMMAND, verdict: 'allow', ok: true }] };
  const run = (events) => evaluateExit({ events, runId: 'x', worktreeBase: '', steps: ['rules'], facts }).rules;
  const good = run([...rule, ...node]);
  assert.deepEqual(names(good), []);
  assert.match(good.find((c) => /approve by rule exercised/.test(c.name)).detail, /default:node-version/);
  // git status was not asked about: only a note, never a failure
  assert.equal(good[0].note, true);
  assert.match(good[0].detail, /did not ask/);

  // no request answered by a rule at all: the step fails (the 2026-11-14 gap)
  assert.match(names(run(node)).join(), /answered by a default rule/);
  // a rule answer that was not a default rule, or took a person, does not count
  const manual = rule.map((e) => (e.type === 'approval.resolved' ? { ...e, by: 'user', policyRuleId: undefined } : e));
  assert.match(names(run([...manual, ...node])).join(), /answered by a default rule/);
  const slow = rule.map((e) => (e.type === 'approval.resolved' ? { ...e, ts: 5000 } : e));
  assert.match(names(run([...slow, ...node])).join(), /waited for a person/);
  // a git status request that waited for a person fails too; one answered by a rule next to the version command passes
  const gitAsked = ev('approval.requested', 1, { request: { requestId: 'g1', toolName: 'Bash', toolInput: { command: 'git status' } } });
  assert.match(names(run([...rule, gitAsked, ...node])).join(), /waited for a person/);
  const gitRuled = [gitAsked, ev('approval.resolved', 2, { requestId: 'g1', by: 'policy', outcome: 'allowed', policyRuleId: 'default:git-status' })];
  assert.deepEqual(names(run([...rule, ...gitRuled, ...node])), []);

  const notAllowed = run([...rule, ...node.slice(0, 1)]);
  assert.match(names(notAllowed).join(), /resolved allowed by the user/);
});

test('budget: no pause by the Huddle, or a run that never held a tool call, fails', () => {
  const tokens = ev('usage.recorded', 1, { inputTokens: 10, outputTokens: 10, cacheCreationTokens: TOKEN_BUDGET, cacheReadTokens: 999999 });
  assert.equal(countedTokens([tokens]), TOKEN_BUDGET + 20, 'cache reads are not counted');
  const full = [
    tokens,
    ev('attention.raised', 2, { item: { kind: 'budget', title: 'main is used up' } }),
    ev('control.applied', 3, { action: 'pause', source: 'huddle' }),
    ev('hold.started', 4),
    ev('hold.ended', 5, { why: 'resumed' }),
    ev('run.result', 6),
  ];
  const facts = { raiseResult: { ok: true }, resumeResults: [{ ok: true }] };
  assert.deepEqual(names(evaluateExit({ events: full, runId: 'x', worktreeBase: '', steps: ['budget'], facts }).budget), []);
  const noHold = full.filter((e) => e.type !== 'hold.started' && e.type !== 'hold.ended');
  assert.match(names(evaluateExit({ events: noHold, runId: 'x', worktreeBase: '', steps: ['budget'], facts }).budget).join(), /hold\.started/);
  const userPause = full.map((e) => (e.type === 'control.applied' ? { ...e, source: 'user' } : e));
  assert.match(names(evaluateExit({ events: userPause, runId: 'x', worktreeBase: '', steps: ['budget'], facts }).budget).join(), /source huddle/);
});

test('budget: a paused subagent that ended before the resume is not resumed; the still-live ones are', () => {
  const pause = (agentKey, ts) => ev('control.applied', ts, { action: 'pause', source: 'huddle', agentKey });
  const events = [pause('main', 10), pause('main::sub1', 10), ev('agent.stopped', 12, { agentKey: 'main::sub1' }), ev('agent.stopped', 5, { agentKey: 'main::sub2' }), pause('main::sub2', 11)];
  assert.deepEqual(splitPausedKeys(events), { resume: ['main', 'main::sub2'], ended: ['main::sub1'] });
  assert.deepEqual(splitPausedKeys([]), { resume: [], ended: [] });
  // a user pause is not the budget's to resume
  assert.deepEqual(splitPausedKeys([ev('control.applied', 1, { action: 'pause', source: 'user', agentKey: 'main' })]), { resume: [], ended: [] });
});

test('discard: a folder or branch left behind fails', () => {
  const events = [
    ev('run.exited', 1, { how: 'completed', exitCode: 0 }),
    ev('worktree.summarized', 2, { filesChanged: 0, untracked: 1 }),
    ev('worktree.closed', 3, { outcome: 'discarded', error: null }),
  ];
  const okFacts = { discardResult: { ok: true }, gitAfter: { folderExists: false, listed: false, branchExists: false } };
  assert.deepEqual(names(evaluateExit({ events, runId: 'x', worktreeBase: '', steps: ['discard'], facts: okFacts }).discard), []);
  const left = { ...okFacts, gitAfter: { folderExists: true, listed: false, branchExists: true } };
  assert.deepEqual(names(evaluateExit({ events, runId: 'x', worktreeBase: '', steps: ['discard'], facts: left }).discard), ['the folder is gone', 'git branch --list no longer shows the branch']);
});

test('discard: a busy folder is recognised (Windows messages), a plain failure is not; the notes name what the changed files were', () => {
  assert.equal(isBusyFailure("The worktree was not discarded: git worktree remove failed: error: failed to delete 'C:/x': Permission denied"), true);
  assert.equal(isBusyFailure("the worktree folder could not be removed: EBUSY: resource busy or locked, rmdir 'C:/x'"), true);
  assert.equal(isBusyFailure('refused: the run is still running'), false);
  assert.equal(isBusyFailure(undefined), false);
  const events = [
    ev('run.exited', 1, { how: 'completed', exitCode: 0 }),
    ev('worktree.summarized', 2, { filesChanged: 2, untracked: 2, files: [{ path: '.omc/state/a.json' }, { path: '.omc/project-memory.json' }] }),
    ev('worktree.closed', 3, { outcome: 'discarded', error: null }),
  ];
  const facts = { discardResult: { ok: true }, discardRetries: 1, gitAfter: { folderExists: false, listed: false, branchExists: false } };
  const list = evaluateExit({ events, runId: 'x', worktreeBase: '', steps: ['discard'], facts }).discard;
  assert.deepEqual(names(list), []);
  assert.match(list.find((c) => /retries/.test(c.name)).detail, /1 retry/);
  assert.equal(list.find((c) => /what the "changed"/.test(c.name)).detail, '.omc/state, .omc/project-memory.json');
});

test('allPassed: a failed check or an early stop is a failed run; notes never fail', () => {
  assert.equal(allPassed({ error: null, checks: { a: [{ pass: true }, { pass: true, note: true }] } }), true);
  assert.equal(allPassed({ error: null, checks: { a: [{ pass: false }] } }), false);
  assert.equal(allPassed({ error: 'timed out', checks: {} }), false);
});

// --- the whole scenario against the real HuddleCore with a fake claude ---------------------------------------------------

test('self-test: launch, worktree, rules, budget pause and resume, discard, hygiene (real HuddleCore over HTTP, fake claude)', { timeout: 240000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-m4-selftest-'));
  const worktreeDir = path.join(root, 'wt-base');
  const lines = [];
  try {
    const summary = await runAll({
      steps: STEPS,
      port: 47942,
      batch: 'selftest',
      timeoutMs: 180000,
      model: 'sonnet',
      claudeCommand: FAKE,
      worktreeDir,
      root,
      log: (l) => lines.push(l),
    });
    const text = lines.join('\n');
    assert.deepEqual(Object.values(summary.checks).flat().filter((c) => !c.pass).map((c) => `${c.name} -- ${c.detail}`), [], text);
    assert.equal(summary.error, null);
    assert.equal(allPassed(summary), true);
    // the fake claude asks about the version commands, so a default rule must have answered and `rules` says how many
    assert.match(summary.checks.rules.find((c) => /approve by rule exercised/.test(c.name)).detail, /default:node-version/);
    for (const id of ['events.jsonl', 'summary.json', 'checks.json', 'template.json', 'settings.redacted.json']) {
      assert.ok(fs.existsSync(path.join(root, '.huddle', 'm4', 'selftest', id)), id);
    }
    const evidence = fs.readdirSync(path.join(root, '.huddle', 'm4', 'selftest'), { recursive: true }).join('\n');
    const redacted = fs.readFileSync(path.join(root, '.huddle', 'm4', 'selftest', 'settings.redacted.json'), 'utf8');
    assert.match(redacted, /<token>/);
    assert.ok(!evidence.includes('settings.json.bak'));
    assert.deepEqual(fs.readdirSync(path.join(worktreeDir, 'worktrees')), [], 'the discarded worktree folder is gone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
