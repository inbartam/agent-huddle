#!/usr/bin/env node
/**
 * Headless Huddle host for scripts/m3-exit.mjs. Runs HuddleCore (TypeScript source, loaded through Vite's SSR loader,
 * the same resolution Vitest uses, so no build step and no new dependency) on a private port with its own data dir.
 * It runs as a child process so the orchestrator can kill it the hard way (scenario "kill while held").
 *
 *   node scripts/lib/m3-host.mjs --port 47931 --data-dir <dir> --claude-dir <dir>   (the token is the FIRST line on stdin, never argv)
 *
 * Protocol, one JSON object per line.
 *   stdout: {op:'ready', port} | {op:'start-failed', message} | {op:'events', events:[...]} | {op:'result', id, result}
 *   stdin:  {op:'command', id, command, sessionId?} | {op:'dispose'}
 * In a command, agentKey "$MAIN" is replaced with the main agent key of `sessionId`.
 * The claude config dir is a throw-away folder: nothing here reads or writes ~/.claude.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { parseArgs } from './common.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const first = await lines.next();
  const token = first.done ? '' : String(first.value).trim();
  if (!token) throw new Error('missing token (first line on stdin)');
  const args = parseArgs(process.argv.slice(2), { booleans: [], values: ['port', 'data-dir', 'claude-dir'] });
  for (const k of ['port', 'data-dir', 'claude-dir']) if (!args[k]) throw new Error(`missing --${k}`);
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
  const huddle = new core.HuddleCore({
    dataDir: args['data-dir'],
    claudeConfigDir: args['claude-dir'],
    cwd: null,
    userAgentsDir: null,
    port: Number(args.port),
    forwarderSource: path.join(REPO, 'scripts', 'huddle-forward-hook.mjs'),
    newToken: () => token,
    batchIntervalMs: 0,
  });
  huddle.onEvents((events) => out({ op: 'events', events }));
  const started = await huddle.start();
  if (!started.ok) {
    out({ op: 'start-failed', message: started.message });
    process.exit(1);
  }
  out({ op: 'ready', port: started.port });
  for (;;) {
    const next = await lines.next();
    if (next.done) break; // stdin closed: the orchestrator is gone
    let msg;
    try { msg = JSON.parse(next.value); } catch { continue; }
    if (msg.op === 'dispose') break;
    if (msg.op === 'command') {
      const command = { ...msg.command };
      if (command.agentKey === '$MAIN' && msg.sessionId) command.agentKey = shared.agentKey(msg.sessionId);
      out({ op: 'result', id: msg.id, result: await huddle.command(command) });
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
