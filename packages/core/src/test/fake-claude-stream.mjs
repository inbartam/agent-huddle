#!/usr/bin/env node
/**
 * A stand-in for `claude -p --input-format stream-json --output-format stream-json --verbose`, used by
 * ingest/stream-driver.test.ts and runtime/huddle-core.launch.test.ts (spawned with process.execPath). No model, no
 * cost, and hooks only when FAKE_HOOK_URL is set. It mimics the S8/S16 behavior the driver depends on: a new system/init per turn, a `result` per turn, stdin read in order, a
 * control_request interrupt answered with a control_response that ends the running turn (error_during_execution),
 * and exit 0 once stdin closes and the current turn is done. It says nothing new about the real CLI.
 *
 * Environment:
 *   FAKE_LOG            file to append JSON lines to: {argv}, {agentsFile}, then {stdin} per line read
 *   FAKE_CAPS           comma-separated init capabilities ("none" for an empty list); default has cancel_queued
 *   FAKE_IGNORE_EOF=1   keep running after stdin closes (so only a hard kill ends it)
 *   FAKE_CHUNKY=1       write output with CRLF, split across chunks at odd places
 *   FAKE_HOOK_URL       e.g. http://127.0.0.1:<port>: post hooks there the way the user-level http hooks would
 *                       (SessionStart at start, PreToolUse before a "slow" tool and wait for its answer, so a pause
 *                       holds it, PostToolUse after); FAKE_HOOK_TOKEN is the X-Huddle-Token. Off when unset.
 *   FAKE_TOUCH=<name>   on the first turn, write <name> in the cwd (a change for a worktree summary)
 *
 * Prompts: "slow <ms>" runs a tool for <ms> (interruptible); "fail" writes stderr and exits 3; anything else answers.
 */
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const log = (obj) => {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(obj)}\n`);
};
const sessionId = flag('--session-id');
const caps =
  process.env.FAKE_CAPS === 'none'
    ? []
    : (process.env.FAKE_CAPS ?? 'interrupt_receipt_v1,interrupt_cancel_queued_v1').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log({ argv });
const agentsFile = flag('--agents');
if (agentsFile !== undefined) {
  const exists = fs.existsSync(agentsFile);
  log({ agentsFile: { exists, names: exists ? Object.keys(JSON.parse(fs.readFileSync(agentsFile, 'utf8'))) : [] } });
}

async function hook(event, extra = {}) {
  const base = process.env.FAKE_HOOK_URL;
  if (!base) return;
  const body = {
    session_id: sessionId,
    transcript_path: 'C:/fake/transcript.jsonl',
    cwd: process.cwd(),
    permission_mode: flag('--permission-mode') ?? 'default',
    hook_event_name: event,
    ...extra,
  };
  try {
    const res = await fetch(`${base}/huddle/hooks/${event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-huddle-token': process.env.FAKE_HOOK_TOKEN ?? '' },
      body: JSON.stringify(body),
    });
    await res.text();
    log({ hook: event, status: res.status });
  } catch (error) {
    log({ hook: event, error: String(error) });
  }
}
const started = hook('SessionStart', { source: 'startup', model: 'claude-fake' });

let pending = Promise.resolve();
async function write(obj) {
  const text = `${JSON.stringify(obj)}${process.env.FAKE_CHUNKY ? '\r\n' : '\n'}`;
  if (!process.env.FAKE_CHUNKY) {
    process.stdout.write(text);
    return;
  }
  // Split each line into three pieces with pauses, so the driver sees partial lines.
  const cuts = [Math.floor(text.length / 3), Math.floor((2 * text.length) / 3)];
  pending = pending.then(async () => {
    process.stdout.write(text.slice(0, cuts[0]));
    await sleep(5);
    process.stdout.write(text.slice(cuts[0], cuts[1]));
    await sleep(5);
    process.stdout.write(text.slice(cuts[1]));
  });
  await pending;
}

let interrupt = null;
let turns = 0;

async function turn(text) {
  turns += 1;
  await started;
  if (turns === 1 && process.env.FAKE_TOUCH) fs.writeFileSync(process.env.FAKE_TOUCH, 'made by the fake');
  await write({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-fake',
    permissionMode: 'default',
    tools: ['Bash', 'Read'],
    capabilities: caps,
    agents: ['general-purpose'],
  });
  if (turns === 1) {
    await write({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1794772800 } } },
      session_id: sessionId,
    });
  }
  if (text === 'fail') {
    process.stderr.write('fatal: boom\n');
    process.exit(3);
  }
  const slow = /^slow (\d+)$/.exec(text);
  if (slow) {
    await write({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_slow', name: 'Bash', input: { command: 'sleep' } }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    const toolInput = { command: 'sleep' };
    // Like claude: the tool runs only once PreToolUse is answered (a Huddle pause holds it here).
    await hook('PreToolUse', { tool_name: 'Bash', tool_input: toolInput, tool_use_id: 'toolu_slow' });
    const how = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('done'), Number(slow[1]));
      interrupt = () => {
        clearTimeout(timer);
        resolve('interrupted');
      };
    });
    interrupt = null;
    if (how === 'done')
      await hook('PostToolUse', { tool_name: 'Bash', tool_input: toolInput, tool_use_id: 'toolu_slow' });
    if (how === 'interrupted') {
      await write({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 1,
        duration_ms: 5,
        total_cost_usd: 0,
        permission_denials: [],
        session_id: sessionId,
      });
      return;
    }
  }
  await write({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `answer to ${text}` }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    duration_ms: 5,
    total_cost_usd: 0.01,
    result: `answer to ${text}`,
    permission_denials: [],
    session_id: sessionId,
  });
}

// Like the real CLI (S8): a turn's user message is taken only after the previous turn's result.
let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log({ stdin: msg });
  if (msg.type === 'control_request') {
    if (msg.request?.subtype === 'interrupt') interrupt?.();
    void write({
      type: 'control_response',
      response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [], cancelled: [] } },
    });
    return;
  }
  if (msg.type === 'user') {
    const text = msg.message?.content?.[0]?.text ?? '';
    chain = chain.then(() => turn(text));
  }
});
rl.on('close', () => {
  if (process.env.FAKE_IGNORE_EOF) {
    setInterval(() => undefined, 1000);
    return;
  }
  // The current turn finishes, then the process exits 0 (S16 b).
  void chain
    .then(() => pending)
    .then(() => {
      process.stdout.write('', () => process.exit(0));
    });
});
