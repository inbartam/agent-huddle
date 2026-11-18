#!/usr/bin/env node
/**
 * A stand-in for `claude -p` used only by scripts/m3-exit.test.mjs (CLAUDE_BIN=<this file>). It reads the same
 * arguments the real run gets (--settings, --session-id, the prompt after -p) and talks to the Huddle the way Claude
 * Code does: HTTP hooks with the token header, holding on PreToolUse and PermissionRequest until answered, and a JSON
 * result on stdout. No model, no cost. Payload shapes follow fixtures/permission-allow.jsonl.
 */
import fs from 'node:fs';
import http from 'node:http';

const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1];
const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
const sessionId = argv[argv.indexOf('--session-id') + 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

function post(event, extra = {}) {
  const hook = settings.hooks[event][0].hooks[0];
  const url = new URL(hook.url);
  const body = JSON.stringify({ session_id: sessionId, transcript_path: 'C:/Users/user/project/t.jsonl', cwd: process.cwd(), permission_mode: 'default', hook_event_name: event, ...extra });
  return new Promise((resolve) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...hook.headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }); } catch { resolve({ ok: true, json: null }); } });
      res.on('error', () => resolve({ ok: false, json: null }));
    });
    req.on('error', () => resolve({ ok: false, json: null }));
    req.end(body);
  });
}

await post('UserPromptSubmit', { prompt });
await sleep(1000);
let result;
let denials = [];
if (prompt.includes('subagent')) {
  // Spike S14(c): the main agent launches a subagent; the subagent's own PreToolUse carries agent_id.
  const sub = { agent_id: 'fakesub1', agent_type: 'general-purpose' };
  await post('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'list files', prompt: 'list files' }, tool_use_id: 'toolu_fake_agent' });
  await post('SubagentStart', sub);
  await sleep(1000);
  const input = { file_path: `${process.cwd()}/notes.txt` };
  const pre = await post('PreToolUse', { ...sub, tool_name: 'Read', tool_input: input, tool_use_id: 'toolu_fake_subread' });
  const ctx = pre.json?.hookSpecificOutput?.additionalContext ?? '';
  await post('PostToolUse', { ...sub, tool_name: 'Read', tool_input: input, tool_use_id: 'toolu_fake_subread' });
  const m = /word (\S+) in your/.exec(ctx);
  const report = `Found notes.txt and package.json.${m ? ` ${m[1]}` : ''}`;
  await post('SubagentStop', { ...sub, stop_hook_active: false, last_assistant_message: report });
  await post('PostToolUse', { tool_name: 'Agent', tool_input: { description: 'list files', prompt: 'list files' }, tool_use_id: 'toolu_fake_agent', tool_response: { agentId: sub.agent_id, status: 'completed' } });
  result = `The subagent reported: ${report}`;
} else if (prompt.includes('npm view')) {
  const input = { command: 'npm view zod version', description: 'Check the zod version' };
  await post('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: 'toolu_fake_bash' });
  const r = await post('PermissionRequest', { tool_name: 'Bash', tool_input: input });
  const d = r.json?.hookSpecificOutput?.decision;
  if (d?.behavior === 'allow') {
    await post('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: 'toolu_fake_bash' });
    result = 'The zod version is 4.1.0.';
  } else if (d?.behavior === 'deny') {
    denials = [{ tool_name: 'Bash' }];
    result = `The command was denied: ${d.message ?? ''}`;
  } else {
    // headless Claude Code with no answer: it denies by itself and finishes
    denials = [{ tool_name: 'Bash' }];
    result = 'That command requires approval, so I could not run it.';
  }
} else {
  const input = { file_path: `${process.cwd()}/package.json` };
  const pre = await post('PreToolUse', { tool_name: 'Read', tool_input: input, tool_use_id: 'toolu_fake_read' });
  const ctx = pre.json?.hookSpecificOutput?.additionalContext ?? '';
  await post('PostToolUse', { tool_name: 'Read', tool_input: input, tool_use_id: 'toolu_fake_read' });
  const m = /exactly (\S+)/.exec(ctx);
  result = `The name field is m3-scratch-project.${m ? `\n${m[1]}` : ''}`;
}
await post('Stop', { stop_hook_active: false });
await post('SessionEnd', { reason: 'other' });
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, duration_ms: Date.now() - t0, total_cost_usd: 0, permission_denials: denials, session_id: sessionId }));
