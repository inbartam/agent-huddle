// Security review M1 (findings 4, 6, 7, 9) for the M0 installer script. Each test runs the real script against a
// temporary config dir (--config-dir), never the user's ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeJsonError } from './lib/common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.join(here, 'install-hooks.mjs');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-install-test-'));

function run(cfg, ...args) {
  return spawnSync(process.execPath, [INSTALLER, '--config-dir', cfg, ...args], { encoding: 'utf8' });
}

function allHooks(settings) {
  return Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks ?? []));
}

test('a parse error names a line and column, never the file content', () => {
  const cfg = tmpDir();
  const secret = 'sk-ant-api03-SECRETSECRETSECRET';
  fs.writeFileSync(path.join(cfg, 'settings.json'), `{\n  "env": { "KEY": "${secret}" ,, }\n}`);
  const r = run(cfg, '--apply');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not valid JSON at line 2, column \d+\./);
  assert.ok(!r.stderr.includes('SECRET') && !r.stdout.includes('SECRET'), 'no fragment of the file is printed');
});

test('describeJsonError takes only numbers from the error', () => {
  assert.equal(describeJsonError('{\n x', new SyntaxError('Unexpected token x in JSON at position 3')), 'not valid JSON at line 2, column 2');
  assert.equal(describeJsonError('x', new Error('quoted "secret"')), 'not valid JSON');
});

test("uninstall keeps a user's wrapper command and https hook that mention the Huddle", () => {
  const cfg = tmpDir();
  const wrapper = { type: 'command', command: `node "${cfg.replace(/\\/g, '/')}/agent-huddle/huddle-forward-hook.mjs" && echo mine` };
  const external = { type: 'http', url: 'https://example.com/huddle/hooks/x' };
  fs.writeFileSync(
    path.join(cfg, 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [wrapper] }], Stop: [{ hooks: [external] }] } }),
  );
  assert.equal(run(cfg, '--apply').status, 0);
  const installed = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.ok(allHooks(installed).length > 2, 'the Huddle hooks were added');
  const r = run(cfg, '--uninstall', '--apply');
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.deepEqual(allHooks(after), [wrapper, external]);
});

test('writes settings.json atomically, owner-only, with an owner-only backup and no temp files left', () => {
  const cfg = tmpDir();
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{"theme":"dark"}\n', { mode: 0o644 });
  const r = run(cfg, '--apply');
  assert.equal(r.status, 0, r.stderr);
  const names = fs.readdirSync(cfg);
  assert.deepEqual(names.filter((n) => n.includes('huddle-tmp')), []);
  const backup = names.find((n) => n.startsWith('settings.json.huddle-backup-'));
  assert.ok(backup, 'a backup was made');
  assert.equal(fs.readFileSync(path.join(cfg, backup), 'utf8'), '{"theme":"dark"}\n');
  if (process.platform !== 'win32') {
    // Windows ignores POSIX mode bits; the user-profile ACL protects the files there.
    assert.equal(fs.statSync(path.join(cfg, 'settings.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(cfg, backup)).mode & 0o777, 0o600);
  }
});

test('a symlinked settings.json keeps its link; the target is written', (t) => {
  const cfg = tmpDir();
  const real = path.join(cfg, 'dotfiles', 'claude-settings.json');
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, '{"theme":"dark"}\n');
  const link = path.join(cfg, 'settings.json');
  try {
    fs.symlinkSync(real, link, 'file');
  } catch (err) {
    // Windows without Developer Mode or admin rights refuses to create symbolic links.
    if (err.code === 'EPERM') return t.skip('symbolic links need Developer Mode on Windows');
    throw err;
  }
  const r = run(cfg, '--apply');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link survives');
  const written = JSON.parse(fs.readFileSync(real, 'utf8'));
  assert.equal(written.theme, 'dark');
  assert.ok(allHooks(written).length > 0);
});

// --- status line bridge (F9, ADR-018): --uninstall restores the user's line; temp config dirs only ---------------
function withBridge({ saved, statusLine } = {}) {
  const cfg = tmpDir();
  const huddle = path.join(cfg, 'agent-huddle');
  fs.mkdirSync(huddle);
  const bridge = { type: 'command', command: `node "${huddle.split(path.sep).join('/')}/huddle-statusline.mjs"`, padding: 2 };
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ theme: 'dark', statusLine: statusLine ?? bridge }, null, 2));
  if (saved !== undefined) fs.writeFileSync(path.join(huddle, 'statusline-original.json'), JSON.stringify(saved));
  return { cfg, savedPath: path.join(huddle, 'statusline-original.json') };
}
const readSettings = (cfg) => JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
const USER_LINE = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 2, refreshInterval: 5 };

test('--uninstall restores the saved status line exactly and forgets the saved file', () => {
  const { cfg, savedPath } = withBridge({ saved: { statusLine: USER_LINE, savedAt: 'x' } });
  const r = run(cfg, '--uninstall', '--apply');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /restore your own status line/);
  assert.equal(JSON.stringify(readSettings(cfg).statusLine), JSON.stringify(USER_LINE));
  assert.equal(fs.existsSync(savedPath), false);
});

test('--uninstall removes the key when the saved original was "none"', () => {
  const { cfg } = withBridge({ saved: { statusLine: null } });
  assert.equal(run(cfg, '--uninstall', '--apply').status, 0);
  assert.deepEqual(readSettings(cfg), { theme: 'dark' });
});

test('--uninstall leaves the bridge and prints a note when the saved original is missing', () => {
  const { cfg } = withBridge();
  const before = readSettings(cfg).statusLine;
  const r = run(cfg, '--uninstall', '--apply');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /saved original .* is missing/);
  assert.deepEqual(readSettings(cfg).statusLine, before);
});

test('--uninstall leaves a status line the user changed (not ours) and says so', () => {
  const mine = { type: 'command', command: 'my-line' };
  const { cfg } = withBridge({ saved: { statusLine: USER_LINE }, statusLine: mine });
  const r = run(cfg, '--uninstall', '--apply');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /changed after the Huddle installed/);
  assert.deepEqual(readSettings(cfg).statusLine, mine);
});

test('a dry run --uninstall writes nothing and keeps the saved file', () => {
  const { cfg, savedPath } = withBridge({ saved: { statusLine: USER_LINE } });
  const before = fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8');
  assert.equal(run(cfg, '--uninstall').status, 0);
  assert.equal(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'), before);
  assert.equal(fs.existsSync(savedPath), true);
});

// ADR-019: PreToolUse is held for pauses and question windows, so it gets 600 s; the other events keep theirs.
// The core installer's parity test (packages/core/src/setup/install-hooks.test.ts) checks the whole table matches.
test('install gives PreToolUse and PermissionRequest 600 s, SessionEnd 1 s, everything else 5 s', () => {
  const cfg = tmpDir();
  const r = run(cfg, '--apply');
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  const timeouts = Object.fromEntries(Object.entries(settings.hooks).map(([event, groups]) => [event, groups[0].hooks[0].timeout]));
  const special = { PreToolUse: 600, PermissionRequest: 600, SessionEnd: 1 };
  for (const [event, seconds] of Object.entries(timeouts)) assert.equal(seconds, special[event] ?? 5, event);
  assert.equal(timeouts.PreToolUse, 600);
  assert.equal(timeouts.SessionStart, 5);
});

test('--timeout PreToolUse=60 still overrides the 600 s default', () => {
  const cfg = tmpDir();
  const r = run(cfg, '--apply', '--timeout', 'PreToolUse=60');
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].timeout, 60);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].timeout, 600);
});

// A6-05, A6-06, A6-07, A2-06 / A6-09

test('a re-install with --no-otel removes the earlier Huddle telemetry and keeps foreign keys (A6-05)', () => {
  const cfg = tmpDir();
  assert.equal(run(cfg, '--apply').status, 0);
  assert.ok(readSettings(cfg).env.OTEL_EXPORTER_OTLP_HEADERS.startsWith('X-Huddle-Token='));
  const r = run(cfg, '--apply', '--no-otel');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readSettings(cfg).env, undefined);
  assert.match(r.stdout, /remove \d+ Huddle telemetry env vars/);

  const other = tmpDir();
  fs.writeFileSync(path.join(other, 'settings.json'), JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console' } }));
  assert.equal(run(other, '--apply', '--no-otel').status, 0);
  assert.deepEqual(readSettings(other).env, { OTEL_LOGS_EXPORTER: 'console' });
});

test('install then uninstall in the same second keeps two distinct backups (A6-06)', () => {
  const cfg = tmpDir();
  const original = '{"theme":"dark"}\n';
  fs.writeFileSync(path.join(cfg, 'settings.json'), original);
  assert.equal(run(cfg, '--apply').status, 0);
  assert.equal(run(cfg, '--uninstall', '--apply').status, 0);
  const backups = fs.readdirSync(cfg).filter((n) => n.startsWith('settings.json.huddle-backup-')).sort();
  assert.equal(backups.length, 2);
  const contents = backups.map((n) => fs.readFileSync(path.join(cfg, n), 'utf8'));
  assert.ok(contents.includes(original), 'the first backup holds the original bytes');
  assert.notEqual(contents[0], contents[1]);
});

test('a hooks.<Event> that is not an array is refused and the file is unchanged (A6-07)', () => {
  const cfg = tmpDir();
  const text = '{"hooks":{"Stop":{}}}';
  fs.writeFileSync(path.join(cfg, 'settings.json'), text);
  const r = run(cfg, '--apply');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"hooks\.Stop" in .*settings\.json is not an array/);
  assert.equal(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'), text);
  assert.deepEqual(fs.readdirSync(cfg), ['settings.json']);
});

for (const [label, ch] of [['dollar', '$'], ['backtick', '`'], ['percent', '%']]) {
  test(`a config folder containing a ${label} is refused and nothing is written (A2-06, A6-09)`, () => {
    const parent = tmpDir();
    const cfg = path.join(parent, `a${ch}b`);
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, 'settings.json'), '{"theme":"dark"}\n');
    const r = run(cfg, '--apply');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot be quoted safely/);
    assert.deepEqual(fs.readdirSync(cfg), ['settings.json']);
    assert.equal(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'), '{"theme":"dark"}\n');
  });
}
