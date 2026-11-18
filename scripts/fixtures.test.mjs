// Checks every committed fixture (fixtures/*.jsonl): the ADR-012 link is present and nothing private survived scrubbing.
// The private values are read from this machine at run time (home folder, user name, repo path), never written here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(repo, 'fixtures');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const lines = (f) =>
  read(f)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** Every object key in a value, including OTLP {key: …} attribute names. */
function keys(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => keys(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.key === 'string') out.push(value.key);
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keys(v, out);
    }
  }
  return out;
}

test('there are fixtures to check', () => {
  assert.ok(files.length >= 9, `found ${files.length}`);
  for (const f of ['parallel-subagents.jsonl', 'nested-subagents.jsonl', 'interactive-helpers.jsonl', 'agent-messages.jsonl']) {
    assert.ok(files.includes(f), f);
  }
});

// Fixtures whose recording kept no tool_response at all (the recorder dropped every one): their Agent calls must have
// none either, so nothing is invented. agent-team.jsonl: spike S20 (b), the only recorded agent team.
// agent-team-report.jsonl is derived from it (M6 P5b).
const NO_AGENT_LINK = new Set(['agent-team.jsonl', 'agent-team-report.jsonl']);

for (const f of files) {
  test(`${f}: every PostToolUse(Agent) carries tool_response.agentId and nothing else unexpected`, () => {
    for (const l of lines(f)) {
      if (l.kind !== 'hook' || l.event !== 'PostToolUse') continue;
      const { tool_name, tool_response } = l.payload;
      if (tool_name !== 'Agent' || NO_AGENT_LINK.has(f)) {
        assert.equal(tool_response, undefined, `${f}: ${tool_name} kept a tool_response`);
        continue;
      }
      assert.match(String(tool_response?.agentId), /^agent-\d+$/, `${f} at ${l.t}`);
      for (const k of Object.keys(tool_response)) assert.ok(['agentId', 'isAsync', 'status', 'resolvedModel'].includes(k), `${f}: ${k}`);
    }
  });

  test(`${f}: no email, identity attribute, user name or real path`, () => {
    const text = read(f);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'email');
    const identity = keys(lines(f)).filter((k) => /^(user|organization)\./i.test(k));
    assert.deepEqual(identity, [], 'identity keys');
    assert.doesNotMatch(text, /"(user|organization)\./i, 'identity key text');

    const user = os.userInfo().username;
    if (user.length >= 3 && !/^(user|users|project)$/i.test(user)) {
      assert.doesNotMatch(text, new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), 'user name');
    }
    // Real folders, in Windows, forward-slash, Git Bash (/c/…) and Claude project-folder (C--…) forms.
    for (const p of [os.homedir(), repo, path.dirname(repo)]) {
      const parts = p.split(/[\\/]+/).filter(Boolean);
      const drive = parts[0].replace(':', '');
      const forms = [parts.join('\\'), parts.join('/'), `/${drive.toLowerCase()}/${parts.slice(1).join('/')}`, p.replace(/[^A-Za-z0-9]/g, '-')];
      for (const form of forms) {
        // The file is JSON, so a backslash path appears with doubled backslashes.
        for (const s of [form, JSON.stringify(form).slice(1, -1)]) assert.ok(!text.toLowerCase().includes(s.toLowerCase()), `real path ${form}`);
      }
    }
    // Same shape check as the scrubber used to record them: any drive path must be the fake project path.
    for (const m of text.matchAll(/[A-Za-z]:(?:\\\\|\/)+[^"\s]{0,40}/g)) assert.ok(m[0].startsWith('C:/Users/user/project'), m[0]);
  });
}
