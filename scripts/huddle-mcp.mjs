#!/usr/bin/env node
/**
 * Huddle MCP server (F27 self-reported progress, spike S19): a zero-dependency stdio MCP server with two tools,
 * `report_progress` and (M6 P5b, ADR-027) `report_teammate`, the lead's answer when the Huddle asks whether an idle
 * teammate is finished or waiting. Each tool does nothing but answer `ok`: the Huddle learns about a call from the
 * PostToolUse hook that Claude Code fires for it (tool_input carries the report), not from this process.
 *
 * Protocol (MCP spec 2025-06-18, "Lifecycle" and "Transports"): JSON-RPC 2.0, one message per line on stdin and stdout
 * (newline-delimited, no embedded newlines). initialize -> notifications/initialized -> tools/list, tools/call. stdout carries
 * protocol messages and nothing else; diagnostics would go to stderr, and this server logs nothing (no input is echoed).
 * Shutdown: Claude Code closes stdin; the server exits when it ends.
 *
 *   node scripts/huddle-mcp.mjs            (spawned by Claude Code from an --mcp-config file, never run by hand)
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'huddle';
export const SERVER_VERSION = '0.1.0';
export const TOOL_NAME = 'report_progress';
export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const NOTE_MAX = 200;
export const TEAMMATE_TOOL_NAME = 'report_teammate';
export const NAME_MAX = 100;
export const TEAMMATE_STATUSES = Object.freeze(['finished', 'waiting']);

export const INSTRUCTIONS =
  'The huddle server shows the user how far along you are. Call report_progress at milestones: once when you start (with a first ' +
  'estimate), after each major step, and once just before you finish (fraction 1). Keep it short; the call returns ok and ' +
  'needs no follow-up. If Agent Huddle asks about an idle teammate, answer with report_teammate.';

export const TOOL = Object.freeze({
  name: TOOL_NAME,
  description:
    'Report your progress to the user\'s Agent Huddle dashboard. Call it at milestones: when you start, after each major step, ' +
    'and before you finish. Pass fraction (0 to 1, how much of your task is done), minutesLeft (your estimate of minutes still ' +
    'needed) and/or a short note (at most 200 characters, what you just did or are doing). All fields are optional. Returns "ok".',
  inputSchema: {
    type: 'object',
    properties: {
      fraction: { type: 'number', minimum: 0, maximum: 1, description: 'Share of your task that is done, 0 to 1.' },
      minutesLeft: { type: 'number', minimum: 0, description: 'Your estimate of the minutes still needed.' },
      note: { type: 'string', maxLength: NOTE_MAX, description: 'Short status note, at most 200 characters.' },
    },
    additionalProperties: false,
  },
});

export const TEAMMATE_TOOL = Object.freeze({
  name: TEAMMATE_TOOL_NAME,
  description:
    'Tell the user\'s Agent Huddle dashboard whether an idle teammate is finished or waiting for a result. Call it when ' +
    'Agent Huddle asks about a teammate. Pass name (the teammate\'s name, as Agent Huddle wrote it), status ("finished" or ' +
    '"waiting") and optionally a short note (at most 200 characters). Returns "ok".',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: NAME_MAX, description: 'The teammate\'s name.' },
      status: { type: 'string', enum: [...TEAMMATE_STATUSES], description: 'finished, or waiting for a result.' },
      note: { type: 'string', maxLength: NOTE_MAX, description: 'Short note, at most 200 characters.' },
    },
    required: ['name', 'status'],
    additionalProperties: false,
  },
});

/** Every tool this server lists, in order. */
export const TOOLS = Object.freeze([TOOL, TEAMMATE_TOOL]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Why the arguments of a report_progress call are unusable, or null. Pure. */
export function argumentProblem(args) {
  if (args === undefined) return null;
  if (!isObject(args)) return 'arguments must be an object';
  const { fraction, minutesLeft, note } = args;
  if (fraction !== undefined && !(typeof fraction === 'number' && fraction >= 0 && fraction <= 1)) return 'fraction must be a number from 0 to 1';
  if (minutesLeft !== undefined && !(typeof minutesLeft === 'number' && Number.isFinite(minutesLeft) && minutesLeft >= 0)) return 'minutesLeft must be a number of minutes, 0 or more';
  if (note !== undefined && !(typeof note === 'string' && note.length <= NOTE_MAX)) return `note must be a string of at most ${NOTE_MAX} characters`;
  return null;
}

/** Why the arguments of a report_teammate call are unusable, or null. Pure. */
export function teammateArgumentProblem(args) {
  if (!isObject(args)) return 'arguments must be an object with name and status';
  const { name, status, note } = args;
  if (!(typeof name === 'string' && name.trim().length > 0 && name.length <= NAME_MAX)) return `name must be a string of 1 to ${NAME_MAX} characters`;
  if (!TEAMMATE_STATUSES.includes(status)) return 'status must be "finished" or "waiting"';
  if (note !== undefined && !(typeof note === 'string' && note.length <= NOTE_MAX)) return `note must be a string of at most ${NOTE_MAX} characters`;
  return null;
}

const CHECKS = Object.freeze({ [TOOL_NAME]: argumentProblem, [TEAMMATE_TOOL_NAME]: teammateArgumentProblem });

/**
 * One incoming JSON-RPC message -> the response message, or null (notifications and anything unanswerable). Pure.
 */
export function handleMessage(msg) {
  if (!isObject(msg) || typeof msg.method !== 'string') return null;
  const hasId = msg.id !== undefined && msg.id !== null;
  if (!hasId) return null; // notifications/initialized, notifications/cancelled, ...
  switch (msg.method) {
    case 'initialize': {
      const asked = isObject(msg.params) ? msg.params.protocolVersion : undefined;
      const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return reply(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: 'Agent Huddle progress', version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, { tools: [...TOOLS] });
    case 'tools/call': {
      const p = isObject(msg.params) ? msg.params : {};
      const check = typeof p.name === 'string' && Object.hasOwn(CHECKS, p.name) ? CHECKS[p.name] : null;
      if (check === null) return fail(msg.id, -32602, `Unknown tool: ${String(p.name).slice(0, 64)}`);
      const problem = check(p.arguments);
      if (problem) return reply(msg.id, { content: [{ type: 'text', text: problem }], isError: true });
      return reply(msg.id, { content: [{ type: 'text', text: 'ok' }] });
    }
    default:
      return fail(msg.id, -32601, 'Method not found');
  }
}

/** The stdio loop. Never throws on a bad line; a line that is not JSON gets a parse error with id null. */
export function serve(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const send = (m) => output.write(`${JSON.stringify(m)}\n`);
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send(fail(null, -32700, 'Parse error')); }
    if (Array.isArray(msg)) { for (const m of msg) { const r = handleMessage(m); if (r) send(r); } return undefined; }
    const r = handleMessage(msg);
    if (r) send(r);
    return undefined;
  });
  rl.on('close', () => process.exit(0));
}

/**
 * Is this file the script node was started with? Real paths are compared, so a config folder reached through a junction
 * or symlink still counts (import.meta.url is the real path, argv[1] is the path as typed). A copy lives in each
 * script because they ship standalone.
 */
function isEntryPoint() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const self = fileURLToPath(import.meta.url);
  let a;
  let s;
  try {
    a = fs.realpathSync(argv1);
    s = fs.realpathSync(self);
  } catch {
    a = path.resolve(argv1);
    s = self;
  }
  return norm(a) === norm(s);
}

if (isEntryPoint()) serve();
