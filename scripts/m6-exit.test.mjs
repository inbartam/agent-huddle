import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STEPS, buildMcpTemplate, isLoopbackAddress, judgeAuthRows, judgeMcpApproval, judgeRoundTrip, mcpServersHash, parseNetstat, planFromArgs, selectSteps } from './m6-exit.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'm6-exit.mjs');

test('the dry run prints every step, labels the real-claude one, and runs nothing', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const s of STEPS) assert.match(r.stdout, new RegExp(s.id));
  assert.match(r.stdout, /REAL claude/);
  assert.match(r.stdout, /--yes AND --only mcp/);
  assert.match(r.stdout, /--mcp-config/);
  assert.match(r.stdout, /Dry run: nothing was executed/);
});

test('--yes alone never includes the real-claude step; --only mcp does; --dry-run wins; unknown ids are refused', () => {
  assert.equal(planFromArgs(['--yes']).run, true);
  assert.ok(!planFromArgs(['--yes']).willRun.includes('mcp'));
  assert.ok(planFromArgs(['--yes', '--only', 'mcp']).willRun.includes('mcp'));
  assert.ok(!planFromArgs(['--yes', '--only', 'phone']).willRun.includes('mcp'));
  assert.equal(planFromArgs(['--yes', '--dry-run']).run, false);
  assert.deepEqual(selectSteps('teams').map((s) => s.id), ['teams', 'hygiene']);
  assert.throws(() => selectSteps('nope'), /Unknown step/);
  assert.throws(() => planFromArgs(['--bogus']), /Unknown option/);
});

test('mcpServersHash compares only the mcpServers key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-test-'));
  try {
    const f = path.join(dir, '.claude.json');
    fs.writeFileSync(f, JSON.stringify({ a: 1, mcpServers: { x: { command: 'n' } } }));
    const h1 = mcpServersHash(f);
    fs.writeFileSync(f, JSON.stringify({ a: 2, numStartups: 9, mcpServers: { x: { command: 'n' } } }));
    assert.equal(mcpServersHash(f), h1);
    fs.writeFileSync(f, JSON.stringify({ a: 2, mcpServers: { x: { command: 'm' } } }));
    assert.notEqual(mcpServersHash(f), h1);
    assert.equal(mcpServersHash(path.join(dir, 'missing.json')), 'absent');
    fs.writeFileSync(f, '{nope');
    assert.equal(mcpServersHash(f), 'unreadable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseNetstat keeps the listeners of one pid; loopback is told from the rest', () => {
  const text = [
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1716',
    '  TCP    127.0.0.1:50534        0.0.0.0:0              LISTENING       4242',
    '  TCP    192.168.1.23:58749    0.0.0.0:0              LISTENING       4242',
    '  TCP    [::1]:5000             [::]:0                 LISTENING       4242',
    '  TCP    192.168.1.23:58749    1.2.3.4:5              ESTABLISHED     4242',
  ].join('\n');
  const l = parseNetstat(text, 4242);
  assert.deepEqual(l.map((x) => `${x.address}:${x.port}`), ['127.0.0.1:50534', '192.168.1.23:58749', '[::1]:5000']);
  assert.deepEqual(l.filter((x) => !isLoopbackAddress(x.address)).map((x) => x.address), ['192.168.1.23']);
});

test('auth rows pass only on the listed refusal; a 200 where a refusal is expected fails', () => {
  const rows = judgeAuthRows([
    { name: 'a', status: 401, expect: [401] },
    { name: 'b', status: 200, expect: [403] },
  ]);
  assert.deepEqual(rows.map((r) => r.pass), [true, false]);
});

test('round trip verdict: equal, the empty mcpServers caveat, and a real difference', () => {
  assert.deepEqual(judgeRoundTrip({ a: 1 }, { a: 1 }), { equal: true, caveat: false });
  assert.deepEqual(judgeRoundTrip({ a: 1 }, { a: 1, mcpServers: {} }), { equal: false, caveat: true });
  assert.deepEqual(judgeRoundTrip({ a: 1, mcpServers: { x: 1 } }, { a: 1, mcpServers: {} }), { equal: false, caveat: false });
  assert.deepEqual(judgeRoundTrip({ a: 1 }, { a: 2, mcpServers: {} }), { equal: false, caveat: false });
});

test('the mcp template has one subagent, self-report on, haiku; only read-only approvals are allowed', () => {
  const t = buildMcpTemplate({ cwd: 'C:/x' });
  assert.equal(t.model, 'haiku');
  assert.equal(t.selfReport, true);
  assert.deepEqual(Object.keys(t.agents), ['huddle-counter']);
  assert.equal(judgeMcpApproval({ toolName: 'Read' }), true);
  assert.equal(judgeMcpApproval({ toolName: 'Bash' }), false);
});
