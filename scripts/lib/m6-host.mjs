#!/usr/bin/env node
/**
 * Headless Huddle host for scripts/m6-exit.mjs. Like m3-host.mjs and m4-host.mjs (HuddleCore from TypeScript source through
 * Vite's SSR loader, a private port, its own data dir, a child process so the orchestrator can kill it), with the M6 harness
 * options:
 *   --phone-loopback     test-only: the phone listener may bind 127.0.0.1 (replaces the private-LAN address rule). Used ONLY when this
 *                        computer has no private LAN IPv4; the orchestrator labels that run as an override.
 *   --settings-file <f>  per-run `--settings` file for a real managed run (hooks to this host's port); implies skipAttachCheck
 *   --real-claude        launch finds `claude` on PATH (default: no claude is ever started by this host)
 *   --claude-command <f> a .mjs stand-in for claude (the self-test), run under this node; implies the launch options of --real-claude
 * Self-report registration always uses the temp folders: the registrar's home dir is <data-dir>/home, CLAUDE_CONFIG_DIR is
 * --claude-dir, and `claude mcp add|remove` is the FAKE claude (packages/core/src/test/fake-claude-mcp.mjs, which refuses a config
 * dir outside the OS temp folder). So this host never reads or writes the real ~/.claude or ~/.claude.json.
 *
 *   node scripts/lib/m6-host.mjs --port 0 --data-dir <dir> --claude-dir <dir> [--phone-loopback] [--settings-file <f>] [--real-claude]
 *   (the token is the FIRST line on stdin, never argv)
 *
 * stdout: {op:'ready', port, pid} | {op:'start-failed', message} | {op:'events', events} | {op:'result', id, result}
 * stdin:  {op:'command', id, command} | {op:'query', id, query} | {op:'agents', id} | {op:'progress', id} | {op:'dispose'}
 *   agents   -> [{key, kind, parentKey, status, name, role, selfReport}] for every node
 *   progress -> {<agentKey>: {basis, fraction}} (selectProgress, the same call the UI makes)
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { parseArgs } from './common.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_CLAUDE = path.join(REPO, 'packages', 'core', 'src', 'test', 'fake-claude-mcp.mjs');
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const runFake = (_command, args, options) =>
  new Promise((resolve) => {
    execFile(process.execPath, [FAKE_CLAUDE, ...args], { env: options.env, cwd: options.cwd, windowsHide: true }, (e, o, r) => {
      resolve({ code: e === null ? 0 : typeof e.code === 'number' ? e.code : null, stdout: o, stderr: r });
    });
  });

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const first = await lines.next();
  const token = first.done ? '' : String(first.value).trim();
  if (!token) throw new Error('missing token (first line on stdin)');
  const args = parseArgs(process.argv.slice(2), {
    booleans: ['phone-loopback', 'real-claude'],
    values: ['port', 'data-dir', 'claude-dir', 'settings-file', 'claude-command'],
  });
  for (const k of ['port', 'data-dir', 'claude-dir']) if (args[k] === undefined) throw new Error(`missing --${k}`);
  const vite = await createServer({
    root: REPO,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    // ws:false: no HMR websocket (Vite otherwise listens on 0.0.0.0:24678), so the only listeners are the Huddle's own.
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  const core = await vite.ssrLoadModule(path.join(REPO, 'packages/core/src/index.ts'));
  const shared = await vite.ssrLoadModule('@huddle/shared');
  fs.mkdirSync(args['data-dir'], { recursive: true });
  fs.mkdirSync(args['claude-dir'], { recursive: true });
  const home = path.join(args['data-dir'], 'home');
  fs.mkdirSync(home, { recursive: true });
  const deps = {
    dataDir: args['data-dir'],
    claudeConfigDir: args['claude-dir'],
    cwd: null,
    userAgentsDir: null,
    port: Number(args.port),
    forwarderSource: path.join(REPO, 'scripts', 'huddle-forward-hook.mjs'),
    mcpServerSource: path.join(REPO, 'scripts', 'huddle-mcp.mjs'),
    newToken: () => token,
    batchIntervalMs: 0,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    selfReportRegistrar: {
      homeDir: home,
      env: { ...process.env, CLAUDE_CONFIG_DIR: args['claude-dir'] },
      runClaude: runFake,
      claudeCommand: path.join(args['data-dir'], 'claude.exe'),
      nodeCommand: process.execPath,
    },
  };
  if (args['phone-loopback']) deps.phone = { addressCheck: () => null };
  if (args['real-claude'] || args['claude-command']) {
    deps.launch = { skipAttachCheck: true, ...(args['settings-file'] ? { settingsFile: args['settings-file'] } : {}) };
    const cmd = args['claude-command'];
    if (cmd) {
      if (!cmd.endsWith('.mjs')) throw new Error('--claude-command must be a .mjs stand-in; real claude is found on PATH with --real-claude');
      const { spawn } = await import('node:child_process');
      deps.launch.spawn = (_command, argv, options) => spawn(process.execPath, [cmd, ...argv], options);
    }
  }
  const huddle = new core.HuddleCore(deps);
  huddle.onEvents((events) => out({ op: 'events', events }));
  const started = await huddle.start();
  if (!started.ok) {
    out({ op: 'start-failed', message: started.message });
    process.exit(1);
  }
  out({ op: 'ready', port: started.port, pid: process.pid });
  for (;;) {
    const next = await lines.next();
    if (next.done) break; // stdin closed: the orchestrator is gone
    let msg;
    try {
      msg = JSON.parse(next.value);
    } catch {
      continue;
    }
    if (msg.op === 'dispose') break;
    if (msg.op === 'command') out({ op: 'result', id: msg.id, result: await huddle.command(msg.command) });
    else if (msg.op === 'query') out({ op: 'result', id: msg.id, result: await huddle.query(msg.query) });
    else if (msg.op === 'agents') {
      const agents = Object.values(huddle.getState().agents).map((a) => ({
        key: a.key,
        kind: a.kind,
        parentKey: a.parentKey ?? null,
        status: a.status,
        name: a.name,
        role: a.role,
        sessionId: a.sessionId,
        selfReport: a.selfReport ?? null,
      }));
      out({ op: 'result', id: msg.id, result: agents });
    } else if (msg.op === 'progress') {
      const state = huddle.getState();
      const res = {};
      for (const key of Object.keys(state.agents)) {
        const p = shared.selectProgress(state, key, Date.now(), { priors: state.priors ?? null });
        if (p) res[key] = { basis: p.basis, fraction: p.fraction };
      }
      out({ op: 'result', id: msg.id, result: res });
    }
  }
  await huddle.dispose();
  await vite.close();
  process.exit(0);
}

main().catch((err) => {
  out({ op: 'start-failed', message: String(err?.stack ?? err) });
  process.exit(1);
});
