#!/usr/bin/env node
/**
 * Agent Huddle — command-hook forwarder.
 *
 * Why this exists: Claude Code's SessionStart event does not support `type: "http"`
 * hooks, only command hooks. This script reads the hook payload from stdin and
 * POSTs it to the local Huddle server, so SessionStart arrives like every other event.
 *
 * Contract: it must never get in Claude Code's way.
 *   - never prints plain text to stdout (plain-text stdout of a SessionStart hook is added to Claude's context)
 *   - always exits 0, also when the Huddle is not running
 *   - gives up after 2 seconds
 *
 * "Huddle not running" hint (ADR-014): when nothing listens on the Huddle port (ECONNREFUSED), the
 * Huddle has crashed or quit without removing its hooks, so every HTTP hook in this session will print
 * an error. The forwarder then prints ONE JSON object, {"systemMessage": "..."}, which Claude Code shows
 * to the user and does not add to Claude's context (docs/INTEGRATION.md §1, S11). It does this
 * only on a session's own start (source startup or resume), not again on /clear or compaction.
 *
 * Self-contained on purpose: install-hooks.mjs copies this single file into
 * <claude config dir>/agent-huddle/ so the hook keeps working if the repo moves.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const done = () => process.exit(0);
setTimeout(done, 2000).unref();

// Config comes only from the Claude config directory, never from next to this script:
// a config.json planted beside a copy of the script must not redirect payloads or the token.
function loadConfig() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, 'agent-huddle', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** The one-line hint, as a single JSON object so Claude Code treats it as JSON output, not context. */
function hintLine(config) {
  const cmd =
    typeof config.uninstallCommand === 'string' && config.uninstallCommand.length <= 500
      ? config.uninstallCommand
      : 'npm run hooks:uninstall (in the agent-huddle folder)';
  const text = `Agent Huddle isn't running, so its hooks will show errors in this session. Start Agent Huddle, or remove its hooks with: ${cmd}`;
  return `${JSON.stringify({ systemMessage: text })}\n`;
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  try {
    const body = Buffer.concat(chunks);
    let eventName = 'Unknown';
    let startSource = '';
    try {
      const payload = JSON.parse(body.toString('utf8'));
      eventName = String(payload.hook_event_name || 'Unknown');
      startSource = String(payload.source || '');
    } catch {
      // forward anyway; the server logs unparseable bodies as an error
    }
    const config = loadConfig();
    const headers = { 'content-type': 'application/json', 'content-length': body.length };
    if (config.token) headers['x-huddle-token'] = config.token;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(config.port) || 47821,
        path: `/huddle/hooks/${encodeURIComponent(eventName)}`,
        method: 'POST',
        headers,
        timeout: 1500,
      },
      (res) => {
        res.resume();
        res.on('end', done);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (err) => {
      const showHint =
        err && err.code === 'ECONNREFUSED' && eventName === 'SessionStart' && (startSource === 'startup' || startSource === 'resume');
      if (!showHint) return done();
      process.stdout.write(hintLine(config), done);
    });
    req.end(body);
  } catch {
    done();
  }
});
