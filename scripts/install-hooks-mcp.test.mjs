// The installer script's opt-in self-report step (M6 P4, F27, ADR-025). Each test runs the real script against a temp
// config dir (--config-dir) with the fake claude (packages/core/src/test/fake-claude-mcp.mjs), which refuses any
// CLAUDE_CONFIG_DIR outside the OS temp folder. The real ~/.claude.json `mcpServers` is compared before and after.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeJsonLocation } from './lib/mcp-register.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.join(here, 'install-hooks.mjs');
const FAKE = path.join(here, '..', 'packages', 'core', 'src', 'test', 'fake-claude-mcp.mjs');

// The real ~/.claude.json is rewritten by every running Claude Code session (startup counts, project state), so a hash
// of the whole file fails at random; the part this code could change is `mcpServers` (S19 g compared that key too).
const hashOf = (f) => {
  if (!fs.existsSync(f)) return 'absent';
  try {
    const servers = JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers ?? null;
    return crypto.createHash('sha256').update(JSON.stringify(servers)).digest('hex');
  } catch {
    return 'unreadable';
  }
};
const realClaudeJson = path.join(os.homedir(), '.claude.json');
const realBefore = hashOf(realClaudeJson);
after(() => assert.equal(hashOf(realClaudeJson), realBefore, 'the real ~/.claude.json was not touched'));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-install-mcp-test-'));
function run(cfg, ...args) {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [INSTALLER, '--config-dir', cfg, '--claude-command', FAKE, ...args], { encoding: 'utf8', env });
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('claudeJsonLocation: never sets CLAUDE_CONFIG_DIR to ~/.claude (that would move the file)', () => {
  const home = path.resolve('/home/u');
  assert.deepEqual(claudeJsonLocation(path.join(home, '.claude'), home, { A: '1' }), {
    file: path.join(home, '.claude.json'),
    childEnv: { A: '1' },
  });
  const cfg = path.resolve('/tmp/c');
  assert.equal(claudeJsonLocation(cfg, home, {}).childEnv.CLAUDE_CONFIG_DIR, cfg);
});

test('--mcp without --apply shows the exact command and changes nothing', () => {
  const cfg = tmpDir();
  const r = run(cfg, '--mcp');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Register the self-report MCP server \(DRY RUN\)/);
  assert.match(r.stdout, /run: .* mcp add --scope user huddle -- .*agent-huddle\/huddle-mcp\.mjs/);
  assert.ok(!fs.existsSync(path.join(cfg, '.claude.json')));
  assert.ok(!fs.existsSync(path.join(cfg, 'agent-huddle', 'huddle-mcp.mjs')));
  assert.ok(!fs.existsSync(path.join(cfg, 'settings.json')));
});

test('without --mcp nothing about MCP happens on install', () => {
  const cfg = tmpDir();
  const r = run(cfg, '--apply');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /self-report/);
  assert.ok(!fs.existsSync(path.join(cfg, '.claude.json')));
});

test('--mcp --apply registers; --uninstall --apply removes it; .claude.json deep-equal after the round trip', () => {
  const cfg = tmpDir();
  const original = { numStartups: 1, mcpServers: { mine: { type: 'stdio', command: 'x', args: [] } } };
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify(original));
  const r = run(cfg, '--mcp', '--apply');
  assert.equal(r.status, 0, r.stderr);
  const added = readJson(path.join(cfg, '.claude.json'));
  assert.deepEqual(added.mcpServers.huddle.args, [path.join(cfg, 'agent-huddle', 'huddle-mcp.mjs').replace(/\\/g, '/')]);
  assert.ok(fs.existsSync(path.join(cfg, 'agent-huddle', 'huddle-mcp.mjs')));
  const u = run(cfg, '--uninstall', '--apply');
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual(readJson(path.join(cfg, '.claude.json')), original);
  assert.ok(!fs.existsSync(path.join(cfg, 'agent-huddle', 'huddle-mcp.mjs')));
});

test('a "huddle" server that is not ours: --mcp stops, --uninstall leaves it', () => {
  const cfg = tmpDir();
  const theirs = { mcpServers: { huddle: { command: 'python', args: ['h.py'] } } };
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify(theirs));
  const r = run(cfg, '--mcp', '--apply');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not Agent Huddle's/);
  assert.ok(!fs.existsSync(path.join(cfg, 'settings.json')), 'nothing else was written either');
  const u = run(cfg, '--uninstall', '--apply');
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual(readJson(path.join(cfg, '.claude.json')), theirs);
});
