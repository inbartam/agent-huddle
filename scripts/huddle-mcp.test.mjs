import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  handleMessage,
  argumentProblem,
  INSTRUCTIONS,
  NAME_MAX,
  TEAMMATE_TOOL,
  TEAMMATE_TOOL_NAME,
  teammateArgumentProblem,
  TOOL,
  TOOL_NAME,
} from './huddle-mcp.mjs';

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'huddle-mcp.mjs');

test('handshake, tools/list and tools/call over real stdio; stdout carries only protocol messages', async () => {
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', (l) => lines.push(l));
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: TOOL_NAME, arguments: { fraction: 0.4, note: 'step one' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: TEAMMATE_TOOL_NAME, arguments: { name: 'alpha', status: 'finished' } } });
  child.stdin.write('not json\n');
  child.stdin.end();
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, 'exits when stdin closes');
  assert.equal(stderr, '', 'logs nothing');
  const msgs = lines.map((l) => JSON.parse(l)); // every stdout line must be JSON
  assert.equal(msgs.length, 5, 'one reply per request, none for the notification');
  assert.equal(msgs[0].result.serverInfo.name, 'huddle');
  assert.equal(msgs[0].result.protocolVersion, '2025-06-18');
  assert.equal(msgs[0].result.instructions, INSTRUCTIONS);
  assert.deepEqual(
    msgs[1].result.tools.map((t) => t.name),
    ['report_progress', 'report_teammate'],
  );
  assert.deepEqual(msgs[1].result.tools[1].inputSchema.required, ['name', 'status']);
  assert.deepEqual(msgs[2].result, { content: [{ type: 'text', text: 'ok' }] });
  assert.deepEqual(msgs[3].result, { content: [{ type: 'text', text: 'ok' }] });
  assert.equal(msgs[4].error.code, -32700);
});

test('unknown client protocol version gets the newest one this server supports', () => {
  const r = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.match(r.result.protocolVersion, /^\d{4}-\d\d-\d\d$/);
  assert.notEqual(r.result.protocolVersion, '1999-01-01');
});

test('the tool description and instructions ask for milestone reports', () => {
  assert.match(TOOL.description, /start/);
  assert.match(TOOL.description, /finish/);
  assert.match(INSTRUCTIONS, /report_progress/);
});

test('bad arguments come back as a tool error; unknown tool and method are protocol errors', () => {
  const call = (args) => handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: TOOL_NAME, arguments: args } });
  for (const bad of [{ fraction: 2 }, { fraction: -0.1 }, { minutesLeft: -1 }, { note: 'x'.repeat(201) }, { note: 5 }]) {
    assert.equal(call(bad).result.isError, true, JSON.stringify(bad));
  }
  assert.equal(call({}).result.isError, undefined, 'all fields are optional');
  assert.equal(call({ fraction: 1, minutesLeft: 0, note: 'x'.repeat(200) }).result.content[0].text, 'ok');
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'other' } }).error.code, -32602);
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' }).error.code, -32601);
  assert.equal(argumentProblem(undefined), null);
});

test('report_teammate: name and status required, status finished or waiting, note optional and bounded', () => {
  const call = (args) =>
    handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: TEAMMATE_TOOL_NAME, arguments: args } });
  for (const bad of [
    undefined,
    {},
    { name: 'alpha' },
    { status: 'finished' },
    { name: '', status: 'finished' },
    { name: '   ', status: 'waiting' },
    { name: 'x'.repeat(NAME_MAX + 1), status: 'finished' },
    { name: 'alpha', status: 'done' },
    { name: 7, status: 'finished' },
    { name: 'alpha', status: 'waiting', note: 'x'.repeat(201) },
    { name: 'alpha', status: 'waiting', note: 3 },
  ]) {
    assert.equal(call(bad).result.isError, true, JSON.stringify(bad));
    assert.equal(typeof teammateArgumentProblem(bad), 'string');
  }
  assert.equal(call({ name: 'alpha', status: 'finished' }).result.content[0].text, 'ok');
  assert.equal(call({ name: 'x'.repeat(NAME_MAX), status: 'waiting', note: 'x'.repeat(200) }).result.content[0].text, 'ok');
  assert.match(TEAMMATE_TOOL.description, /finished/);
  assert.match(TEAMMATE_TOOL.description, /waiting/);
  assert.match(INSTRUCTIONS, /report_teammate/);
  assert.deepEqual(TEAMMATE_TOOL.inputSchema.properties.status.enum, ['finished', 'waiting']);
  // A name that is an Object.prototype member is still an unknown tool.
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'constructor' } }).error.code, -32602);
});

test('answers when started through a junction (A6-01)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-mcp-junction-'));
  try {
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    fs.copyFileSync(server, path.join(real, 'huddle-mcp.mjs'));
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link, 'junction');
    const child = spawn(process.execPath, [path.join(link, 'huddle-mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    readline.createInterface({ input: child.stdout }).on('line', (l) => lines.push(l));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
    assert.equal(lines.length, 1, 'one reply');
    assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: {} });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
