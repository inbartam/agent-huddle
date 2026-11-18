import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STEPS, allPassed, etaSummary, judgeVitest, planFromArgs, selectSteps } from './m5-exit.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'm5-exit.mjs');

test('the dry run prints the plan and exits 0 without running anything', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const s of STEPS) assert.match(r.stdout, new RegExp(s.id));
  assert.match(r.stdout, /dry run/);
});

test('--dry-run wins over --yes; --only narrows but keeps hygiene; unknown ids are refused', () => {
  assert.equal(planFromArgs(['--yes', '--dry-run']).run, false);
  assert.equal(planFromArgs(['--yes']).run, true);
  assert.deepEqual(selectSteps('exit3').map((s) => s.id), ['exit3', 'hygiene']);
  assert.throws(() => selectSteps('exit9'), /Unknown step/);
  assert.throws(() => planFromArgs(['--nope']), /Unknown option/);
});

test('judgeVitest gives one verdict per exit criterion and fails a failed test', () => {
  const report = {
    testResults: [
      {
        assertionResults: [
          { ancestorTitles: ["exit 1: open yesterday's run"], status: 'passed', failureMessages: [] },
          { ancestorTitles: ['exit 2: the report'], status: 'failed', failureMessages: ['mismatch'] },
        ],
      },
    ],
  };
  const j = judgeVitest(report);
  assert.equal(j.exit1.passed, true);
  assert.equal(j.exit2.passed, false);
  assert.equal(j.exit3, undefined);
  assert.equal(allPassed([{ passed: true }, { passed: false }]), false);
});

test('etaSummary keeps only the totals and leave-one-out lines', () => {
  const text = 'noise\ntotal tune: 4/5 runs\n  par 5 5/5 contains\nleave-one-out judge: with priors 8/10\n';
  assert.deepEqual(etaSummary(text), ['total tune: 4/5 runs', 'leave-one-out judge: with priors 8/10']);
});
