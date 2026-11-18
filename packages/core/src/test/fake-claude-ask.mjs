#!/usr/bin/env node
/**
 * A stand-in for the one-shot `claude -p --output-format json …` that Ask the Huddle runs (runtime/ask-runner.ts),
 * spawned with process.execPath by the tests. No model, no cost. It prints a result object shaped like the one S18
 * recorded (`type`, `subtype`, `is_error`, `result`, `session_id`, `usage`, `modelUsage`, `total_cost_usd`,
 * `duration_api_ms`, `api_error_status`). It says nothing new about the real CLI.
 *
 * Environment:
 *   FAKE_LOG        file to write one JSON line to: {argv, cwd, stdin, nested, telemetry} (nested: CLAUDECODE was in the env; telemetry: the OTEL switches it got)
 *   FAKE_ASK_MODE   ok (default) | error | notlogged | status401 | hang | crash | big | garbage
 *   FAKE_PID_FILE   with hang: the pid of a grandchild that also hangs is written here (tree kill check)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const mode = process.env.FAKE_ASK_MODE ?? 'ok';

const TELEMETRY_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
];
const telemetryEnv = () => Object.fromEntries(TELEMETRY_KEYS.map((k) => [k, process.env[k] ?? null]));

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  if (process.env.FAKE_LOG) {
    fs.writeFileSync(
      process.env.FAKE_LOG,
      `${JSON.stringify({ argv, cwd: process.cwd(), stdin, nested: process.env.CLAUDECODE !== undefined, telemetry: telemetryEnv() })}\n`,
    );
  }
  run();
});

function result(fields) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'ask-session-0001',
    uuid: 'u',
    num_turns: 1,
    duration_ms: 1200,
    duration_api_ms: 700,
    total_cost_usd: 0.00084,
    usage: { input_tokens: 10, cache_read_input_tokens: 3000, cache_creation_input_tokens: 700, output_tokens: 42 },
    modelUsage: { 'claude-haiku-5-5': { inputTokens: 10, outputTokens: 42 } },
    permission_denials: [],
    stop_reason: 'end_turn',
    ...fields,
  });
}

function run() {
  switch (mode) {
    case 'ok':
      process.stdout.write('a warning line that is not json\n');
      process.stdout.write(`${result({ result: `ANSWER-MARKER-5e1f: saw ${String(stdin.length)} chars` })}\n`);
      process.exit(0);
      break;
    case 'error':
      process.stdout.write(
        `${result({ subtype: 'error_during_execution', is_error: true, errors: ['overloaded_error: try later'] })}\n`,
      );
      process.exit(1);
      break;
    case 'notlogged':
      process.stdout.write(`${result({ is_error: true, result: 'Not logged in · Please run /login' })}\n`);
      process.exit(1);
      break;
    case 'status401':
      process.stdout.write(`${result({ is_error: true, result: 'API Error', api_error_status: 401 })}\n`);
      process.exit(1);
      break;
    case 'crash':
      process.stderr.write('something broke\n');
      process.exit(3);
      break;
    case 'garbage':
      process.stdout.write('not json at all\n');
      process.exit(0);
      break;
    case 'big': {
      const line = 'x'.repeat(64 * 1024);
      const write = () => {
        while (process.stdout.write(line));
        process.stdout.once('drain', write);
      };
      write();
      break;
    }
    case 'hang': {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(child.pid));
      setInterval(() => {}, 1000);
      break;
    }
    default:
      process.exit(2);
  }
}
