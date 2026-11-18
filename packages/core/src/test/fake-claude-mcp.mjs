#!/usr/bin/env node
/**
 * A stand-in for `claude mcp add --scope user <name> -- <command> [args...]` and `claude mcp remove --scope user <name>`
 * (M6 P4 tests). It edits `<CLAUDE_CONFIG_DIR>/.claude.json` the way S19 g saw Claude Code do it: a top-level
 * `mcpServers.<name>` = `{ type: "stdio", command, args, env: {} }`, every other key kept.
 *
 * It refuses to run without CLAUDE_CONFIG_DIR, and refuses a CLAUDE_CONFIG_DIR that is not inside the OS temp folder,
 * so a test can never touch the real `~/.claude.json`.
 * FAKE_MCP_LOG: append each argv as one JSON line. FAKE_MCP_FAIL=1: exit 1 without writing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
if (process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify(argv)}\n`);

const dir = process.env.CLAUDE_CONFIG_DIR;
const tmp = fs.realpathSync(os.tmpdir()).toLowerCase();
if (!dir || !fs.realpathSync(dir).toLowerCase().startsWith(tmp)) {
  process.stderr.write('fake claude: CLAUDE_CONFIG_DIR must be a temp folder\n');
  process.exit(3);
}
if (process.env.FAKE_MCP_FAIL === '1') {
  process.stderr.write('fake claude: failing as asked\n');
  process.exit(1);
}

const file = path.join(dir, '.claude.json');
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
const write = (value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const [group, verb, scopeFlag, scope, name, ...rest] = argv;
if (group !== 'mcp' || scopeFlag !== '--scope' || scope !== 'user' || !name) {
  process.stderr.write(`fake claude: unexpected argv ${JSON.stringify(argv)}\n`);
  process.exit(2);
}
const config = read();
if (verb === 'add') {
  if (rest[0] !== '--' || rest.length < 2) process.exit(2);
  const servers = config.mcpServers ?? {};
  if (Object.hasOwn(servers, name)) {
    process.stderr.write(`MCP server ${name} already exists in user config\n`);
    process.exit(1);
  }
  servers[name] = { type: 'stdio', command: rest[1], args: rest.slice(2), env: {} };
  config.mcpServers = servers;
  write(config);
  process.stdout.write(`Added stdio MCP server ${name}\nFile modified: ${file}\n`);
} else if (verb === 'remove') {
  if (!config.mcpServers || !Object.hasOwn(config.mcpServers, name)) {
    process.stderr.write(`No user-scoped MCP server found with name: ${name}\n`);
    process.exit(1);
  }
  delete config.mcpServers[name];
  write(config);
  process.stdout.write(`Removed MCP server ${name} from user config\nFile modified: ${file}\n`);
} else {
  process.exit(2);
}
