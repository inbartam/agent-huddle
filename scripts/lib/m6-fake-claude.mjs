#!/usr/bin/env node
/**
 * A stand-in for the managed `claude -p --input-format stream-json ...` run, used only by scripts/m6-exit.test.mjs and by
 * `node scripts/m6-exit.mjs --yes --only mcp --claude-command scripts/lib/m6-fake-claude.mjs` (no model, no cost).
 * m6-host.mjs spawns it under node when --claude-command ends in .mjs.
 *
 * It reads the arguments the Huddle really passes (--settings <file>, --mcp-config <file>, --session-id), refuses to play when the
 * --mcp-config file or the server script it names is missing (the real claude would not have the tool either), waits for the
 * first stdin user message, then plays a three-step task with one subagent: the main agent reports at the start, the subagent
 * starts, reports once and stops, the main agent reports again and finishes. Reports are PostToolUse hooks for
 * `mcp__huddle__report_progress` carrying `tool_input` (the S19 shape; `agent_id` / `agent_type` only for the subagent).
 * Hooks are answered by the host named in the settings file (token header from there). Exits 0 once stdin is closed.
 */
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const sessionId = flag('--session-id');
const settings = JSON.parse(fs.readFileSync(flag('--settings'), 'utf8'));
const mcpConfigFile = flag('--mcp-config');
const TOOL = 'mcp__huddle__report_progress';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const first = settings.hooks.PreToolUse[0].hooks[0];

function post(pathname, body) {
  const url = new URL(first.url);
  const text = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: pathname, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...first.headers } },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
        res.on('error', () => resolve());
      },
    );
    req.on('error', () => resolve());
    req.end(text);
  });
}

const hook = (event, extra = {}) =>
  post(`/huddle/hooks/${event}`, { session_id: sessionId, transcript_path: 'C:/Users/user/project/t.jsonl', cwd: process.cwd(), permission_mode: 'default', hook_event_name: event, ...extra });

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

async function report(who, input, id) {
  await hook('PreToolUse', { ...who, tool_name: TOOL, tool_input: input, tool_use_id: id });
  await hook('PostToolUse', { ...who, tool_name: TOOL, tool_input: input, tool_use_id: id, mcp_server: { name: 'huddle', source: 'dynamic' }, tool_response: [{ type: 'text', text: 'ok' }] });
}

async function turn() {
  let toolAvailable = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf8'));
    const server = cfg.mcpServers?.huddle;
    toolAvailable = server !== undefined && fs.existsSync(String(server.args?.[0]));
  } catch {
    toolAvailable = false;
  }
  write({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake', permissionMode: 'default', tools: ['Read', 'Agent', ...(toolAvailable ? [TOOL] : [])], mcp_servers: toolAvailable ? [{ name: 'huddle', status: 'connected' }] : [], capabilities: ['interrupt_receipt_v1'] });
  await hook('SessionStart', { source: 'startup', model: 'claude-fake' });
  await hook('UserPromptSubmit', { prompt_id: 'prompt-1', prompt: 'a three step task' });
  if (toolAvailable) await report({}, { fraction: 0.1, note: 'step 1: starting' }, 'toolu_main_1');
  const agent = { agent_id: 'fakesub1', agent_type: 'huddle-counter' };
  const input = { description: 'count lines', prompt: 'count the lines', subagent_type: 'huddle-counter' };
  await hook('PreToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: 'toolu_agent_1' });
  await hook('SubagentStart', agent);
  await sleep(300);
  if (toolAvailable) await report(agent, { fraction: 1, note: 'counted' }, 'toolu_sub_1');
  await hook('SubagentStop', { ...agent, stop_hook_active: false, last_assistant_message: 'done' });
  await hook('PostToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: 'toolu_agent_1', tool_response: { agentId: agent.agent_id, status: 'completed' } });
  if (toolAvailable) await report({}, { fraction: 0.9, note: 'step 3: summarizing' }, 'toolu_main_2');
  write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, parent_tool_use_id: null, session_id: sessionId });
  await hook('Stop', { stop_hook_active: false });
  write({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: Date.now() - t0, total_cost_usd: 0, result: 'done', permission_denials: [], session_id: sessionId });
}

let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    write({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [], cancelled: [] } } });
    return;
  }
  if (msg.type === 'user') chain = chain.then(() => turn());
});
rl.on('close', () => {
  void chain.then(async () => {
    await hook('SessionEnd', { reason: 'other' });
    process.stdout.write('', () => process.exit(0));
  });
});
