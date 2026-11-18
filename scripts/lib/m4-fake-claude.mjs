#!/usr/bin/env node
/**
 * A stand-in for the managed `claude -p --input-format stream-json --output-format stream-json --verbose` run, used only
 * by scripts/m4-exit.test.mjs (m4-host.mjs spawns it under node when --claude-command ends in .mjs). No model, no cost.
 *
 * It reads the arguments the Huddle really passes (--settings <file>, --agents <file>, --session-id, --permission-mode),
 * waits for the first stdin user message, then plays the M4 exit scenario against the hooks and the OTLP endpoint named
 * in the settings file (token header from there): for each agent in --agents one subagent that runs `git status`, the
 * last one also `node -e "console.log(1)"`. Every tool call is PreToolUse (held until answered, so a pause holds it),
 * PermissionRequest (held; rule or user answers), PostToolUse. Each step first posts an OTLP `api_request` record with
 * FAKE_TOKENS_PER_REQUEST tokens (default 20000), which is what trips the budget. A denied PermissionRequest ends that
 * tool call without PostToolUse. It writes one file in its cwd (the worktree), prints `system/init`, assistant text and a
 * `result` on stdout, and exits 0 once stdin is closed and the turn is done. Payload shapes follow fixtures/permission-allow.jsonl.
 */
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const sessionId = flag('--session-id');
const settings = JSON.parse(fs.readFileSync(flag('--settings'), 'utf8'));
const agentsFile = flag('--agents');
const agentNames = agentsFile && fs.existsSync(agentsFile) ? Object.keys(JSON.parse(fs.readFileSync(agentsFile, 'utf8'))) : ['agent-a'];
const tokensPerRequest = Number(process.env.FAKE_TOKENS_PER_REQUEST ?? 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const hookHeaders = settings.hooks.PreToolUse[0].hooks[0].headers;

function post(pathname, body) {
  const url = new URL(settings.hooks.PreToolUse[0].hooks[0].url);
  const text = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: pathname, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...hookHeaders } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('error', () => resolve(null));
    req.end(text);
  });
}

const hook = (event, extra = {}) =>
  post(`/huddle/hooks/${event}`, { session_id: sessionId, transcript_path: 'C:/Users/user/project/t.jsonl', cwd: process.cwd(), permission_mode: 'default', hook_event_name: event, ...extra });

const str = (key, v) => ({ key, value: { stringValue: String(v) } });
const int = (key, v) => ({ key, value: { intValue: String(v) } });
let requestCounter = 0;
function apiRequest(agent) {
  requestCounter += 1;
  const attributes = [
    str('event.name', 'api_request'), str('session.id', sessionId), str('model', 'claude-fake'),
    int('input_tokens', 10), int('output_tokens', 200), int('cache_read_tokens', 5000), int('cache_creation_tokens', tokensPerRequest - 210),
    str('cost_usd', '0.01'), str('request_id', `req_fake_${requestCounter}`),
    str('query_source', agent === null ? 'sdk' : 'agent:custom'),
    ...(agent === null ? [] : [str('agent_id', agent.agent_id)]),
  ];
  const body = { resourceLogs: [{ resource: { attributes: [str('service.name', 'claude-code')] }, scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events' }, logRecords: [{ timeUnixNano: `${Date.now()}000000`, body: { stringValue: 'claude_code.api_request' }, attributes }] }] }] };
  return post('/v1/logs', body);
}

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** One tool call of `agent` (null: the main agent). Returns 'ran' or 'denied'. */
async function tool(agent, name, input, id) {
  const who = agent === null ? {} : { agent_id: agent.agent_id, agent_type: agent.agent_type };
  await apiRequest(agent);
  await sleep(2500); // telemetry lands 1-3 s after the call (S0); the budget pause must exist before the next PreToolUse
  await hook('PreToolUse', { ...who, tool_name: name, tool_input: input, tool_use_id: id });
  const answer = await hook('PermissionRequest', { ...who, tool_name: name, tool_input: input });
  const decision = answer?.hookSpecificOutput?.decision;
  if (decision?.behavior === 'deny') return 'denied';
  await hook('PostToolUse', { ...who, tool_name: name, tool_input: input, tool_use_id: id });
  return 'ran';
}

async function turn(prompt) {
  write({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake', permissionMode: 'default', tools: ['Bash', 'Read', 'Agent'], capabilities: ['interrupt_receipt_v1'], agents: agentNames });
  await hook('SessionStart', { source: 'startup', model: 'claude-fake' });
  await hook('UserPromptSubmit', { prompt_id: 'prompt-1', prompt });
  fs.writeFileSync('m4-scratch-note.txt', 'made by the fake claude\n');
  const denied = [];
  const reports = [];
  for (let i = 0; i < agentNames.length; i++) {
    const agent = { agent_id: `fakesub${i + 1}`, agent_type: agentNames[i] };
    const input = { description: `run ${agentNames[i]}`, prompt: 'run the commands', subagent_type: agentNames[i] };
    await hook('PreToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: `toolu_agent_${i + 1}` });
    await hook('SubagentStart', agent);
    // mirrors the prompt in m4-exit.mjs: two safe version commands each, git status for the first, node -e for the last
    const commands = [...(i === 0 ? ['git status'] : []), 'node --version', 'npm --version', ...(i === agentNames.length - 1 ? ['node -e "console.log(1)"'] : [])];
    for (const [n, command] of commands.entries()) {
      const r = await tool(agent, 'Bash', { command, description: 'm4 exit step' }, `toolu_sub${i + 1}_${n}`);
      if (r === 'denied') denied.push({ tool_name: 'Bash' });
    }
    const report = `${agentNames[i]} done`;
    reports.push(report);
    await hook('SubagentStop', { ...agent, stop_hook_active: false, last_assistant_message: report });
    await hook('PostToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: `toolu_agent_${i + 1}`, tool_response: { agentId: agent.agent_id, status: 'completed' } });
  }
  const text = reports.join('\n');
  write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: sessionId });
  await hook('Stop', { stop_hook_active: false });
  write({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: Date.now() - t0, total_cost_usd: 0.05, result: text, permission_denials: denied, session_id: sessionId });
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
  if (msg.type === 'user') chain = chain.then(() => turn(msg.message?.content?.[0]?.text ?? ''));
});
rl.on('close', () => {
  void chain.then(async () => {
    await hook('SessionEnd', { reason: 'other' });
    process.stdout.write('', () => process.exit(0));
  });
});
