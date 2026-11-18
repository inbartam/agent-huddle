#!/usr/bin/env node
/**
 * M5 exit check (WP8). Zero new dependencies, Node 22+. Modeled on scripts/m4-exit.mjs, but the M5 exit is about
 * stored history, so almost all of it runs offline against recorded fixtures: no `claude` is started and no model is used.
 *
 *   node scripts/m5-exit.mjs                      dry run: print the plan, run nothing
 *   node scripts/m5-exit.mjs --only exit1,eta     dry run of just these steps
 *   node scripts/m5-exit.mjs --yes                run the offline checks (a few seconds, no model usage)
 *   options: --only <steps>  --out <dir>  --date <YYYY-MM-DD>
 *
 * The exit criteria (docs/ROADMAP.md M5): open yesterday's run, scrub to the moment an agent got stuck and see why;
 * the report for a run matches its events; the scorecard shows a difference between two models on the same role.
 *   exit1  packages/core/src/runtime/m5-exit.test.ts: a real HuddleCore on a private data folder holding a stuck run dated
 *          yesterday (history.list, history.open markers, history.stateAt why[] with last tool call, fate, quietMs, later)
 *   exit2  the same file: every fixture session imported (real JSONL migration into SQLite); report.get counts equal tallies
 *          taken directly from the stored events; the Markdown file equals renderReportMarkdown(report)
 *   exit3  the same file: all 30 recorded runs; role x model table; at least one role has two models, each with
 *          sampleSize >= MIN_PRIOR_SAMPLES, that differ in median time per task or tokens per task
 *   eta    npm run eval:eta (with and without the 15 Sonnet-subagent runs) recorded side by side; constants untouched
 *   hygiene ~/.claude/settings.json hash before and after (always checked)
 * Not automated (owner check): a real managed run that goes quiet. Whether a read-only prompt reliably goes
 * silent for the stuck threshold has not been established, so no real-claude path exists here.
 *
 * Evidence: .huddle/m5/exit-<date>/{vitest.json, exit1-why.txt, exit1.json, exit2-table.txt, exit2.json, exit3-table.txt,
 * exit3.json, eta-all.txt, eta-base.txt, checks.json}. Local only (.huddle/ is git-ignored). Fixture data is scrubbed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/common.mjs';
import { assertSettingsUnchanged, hashSettingsFile, userSettingsPath } from './m3-exit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..');
export const TEST_FILE = 'packages/core/src/runtime/m5-exit.test.ts';
export const ETA_FILE = 'packages/core/src/runtime/eta-eval.test.ts';

export const STEPS = [
  { id: 'exit1', title: "open yesterday's run, scrub to the moment an agent got stuck, see why (history.list / open / stateAt)" },
  { id: 'exit2', title: 'the report for a run matches its events (every fixture session; counts and Markdown file)' },
  { id: 'exit3', title: 'the scorecard shows a difference between two models on the same role (30 recorded runs)' },
  { id: 'eta', title: 'eval:eta and its leave-one-out mode over 15 and 30 runs, recorded (constants untouched)' },
  { id: 'hygiene', title: '~/.claude/settings.json unchanged (always checked)' },
];

export function selectSteps(only) {
  if (!only) return STEPS;
  const ids = String(only).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !STEPS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown step id(s): ${unknown.join(', ')} (known: ${STEPS.map((s) => s.id).join(', ')})`);
  if (!ids.length) throw new Error('--only needs at least one step id');
  return STEPS.filter((s) => ids.includes(s.id) || s.id === 'hygiene');
}

/** Pulls the totals out of `eval:eta` output: the "total ..." and "leave-one-out ..." lines. */
export function etaSummary(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(total (tune|judge)|leave-one-out (tune|judge)|prior pairs)/.test(l));
}

/** Maps vitest's JSON report to a pass/fail per step, by the describe title in the test file. */
export function judgeVitest(report) {
  const results = {};
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      const m = /^exit (\d)/.exec(t.ancestorTitles?.[0] ?? '');
      if (!m) continue;
      results[`exit${m[1]}`] = { passed: t.status === 'passed', status: t.status, message: (t.failureMessages ?? []).join('\n').slice(0, 2000) };
    }
  }
  return results;
}

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function planFromArgs(argv) {
  const args = parseArgs(argv, { booleans: ['yes', 'dry-run', 'help'], values: ['only', 'out', 'date'] });
  if (args.unknown.length) throw new Error(`Unknown option(s): ${args.unknown.join(', ')}`);
  const date = args.date ?? localDate(new Date());
  return {
    steps: selectSteps(args.only),
    run: args.yes === true && args['dry-run'] !== true,
    out: path.resolve(args.out ?? path.join(REPO, '.huddle', 'm5', `exit-${date}`)),
  };
}

function printPlan(plan) {
  console.log('M5 exit check, plan (dry run: nothing is executed):');
  for (const s of plan.steps) console.log(`  ${s.id.padEnd(8)} ${s.title}`);
  console.log(`\nEvidence would go to ${plan.out}`);
  console.log('Offline only: no claude is started, no model is used. Run with --yes to execute.');
  console.log('Owner checks in the real app: a real stuck run (a managed run that goes quiet).');
}

function vitest(args, env = {}) {
  return spawnSync(process.execPath, [path.join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--maxWorkers=2', ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
}

export async function runAll(plan) {
  fs.mkdirSync(plan.out, { recursive: true });
  const settings = userSettingsPath();
  const before = hashSettingsFile(settings);
  const checks = [];
  const ids = new Set(plan.steps.map((s) => s.id));

  if (['exit1', 'exit2', 'exit3'].some((id) => ids.has(id))) {
    const json = path.join(plan.out, 'vitest.json');
    const r = vitest([TEST_FILE, '--reporter=json', `--outputFile=${json}`], { HUDDLE_M5_EVIDENCE_DIR: plan.out });
    let report = {};
    try {
      report = JSON.parse(fs.readFileSync(json, 'utf8'));
    } catch {
      checks.push({ id: 'vitest', passed: false, detail: `no vitest report (exit ${String(r.status)}): ${(r.stderr || '').slice(0, 500)}` });
    }
    const judged = judgeVitest(report);
    for (const id of ['exit1', 'exit2', 'exit3']) {
      if (!ids.has(id)) continue;
      const j = judged[id];
      checks.push({ id, passed: j?.passed === true, detail: j ? j.status + (j.message ? `: ${j.message}` : '') : 'did not run' });
    }
  }

  if (ids.has('eta')) {
    for (const [name, env] of [['eta-base', { HUDDLE_RUNS: 'base' }], ['eta-all', {}]]) {
      const r = vitest([ETA_FILE, '--reporter=verbose'], env);
      const text = `${r.stdout}\n${r.stderr}`;
      fs.writeFileSync(path.join(plan.out, `${name}.txt`), text);
      checks.push({ id: name, passed: r.status === 0, detail: etaSummary(text).join('\n') });
    }
  }

  const after = hashSettingsFile(settings);
  assertSettingsUnchanged(before, after, settings);
  checks.push({ id: 'hygiene', passed: true, detail: `settings.json sha256 unchanged (${before.slice(0, 12)})` });
  fs.writeFileSync(path.join(plan.out, 'checks.json'), JSON.stringify(checks, null, 2));
  return checks;
}

export function allPassed(checks) {
  return checks.length > 0 && checks.every((c) => c.passed);
}

async function main() {
  const plan = planFromArgs(process.argv.slice(2));
  if (!plan.run) {
    printPlan(plan);
    return 0;
  }
  const checks = await runAll(plan);
  for (const c of checks) console.log(`${c.passed ? 'PASS' : 'FAIL'}  ${c.id}${c.detail ? `\n      ${c.detail.split('\n').join('\n      ')}` : ''}`);
  console.log(`\nEvidence: ${plan.out}`);
  return allPassed(checks) ? 0 : 1;
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
