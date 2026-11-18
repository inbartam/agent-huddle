import { describe, expect, it } from 'vitest';
import {
  HUDDLE_MCP_SERVER_KEY,
  HUDDLE_PROGRESS_PROMPT_LINE,
  HUDDLE_PROGRESS_TOOL,
  HUDDLE_PROGRESS_TOOL_SHORT_NAME,
  HUDDLE_TEAMMATE_TOOL,
  huddleMcpConfig,
  huddleMcpConfigJson,
  huddleMcpPermissionsAllow,
  isHuddleServerEntry,
  mcpAddArgs,
  mcpRemoveArgs,
  progressRunSettingsJson,
  userScopeHuddleServer,
  withProgressPromptLine,
  withProgressTool,
} from './huddle-mcp.js';

const SCRIPT = 'C:/Users/user/project/scripts/huddle-mcp.mjs';

describe('huddle MCP per-run pieces (F27, S19)', () => {
  it('names the tool as Claude Code does: mcp__<server key>__<tool>', () => {
    expect(HUDDLE_MCP_SERVER_KEY).toBe('huddle');
    expect(HUDDLE_PROGRESS_TOOL_SHORT_NAME).toBe('report_progress');
    expect(HUDDLE_PROGRESS_TOOL).toBe('mcp__huddle__report_progress');
  });

  it('builds the --mcp-config object S19 ran with (stdio, node, the script path)', () => {
    expect(huddleMcpConfig({ serverScript: SCRIPT })).toEqual({
      mcpServers: { huddle: { type: 'stdio', command: 'node', args: [SCRIPT] } },
    });
  });

  it('JSON text parses back to the same object', () => {
    const json = huddleMcpConfigJson({ serverScript: SCRIPT });
    expect(JSON.parse(json)).toEqual(huddleMcpConfig({ serverScript: SCRIPT }));
    expect(json.endsWith('\n')).toBe(true);
  });

  it('accepts a backslash path with spaces and an absolute node.exe (both ran in S19)', () => {
    const script = 'C:\\Program Files\\Agent Huddle\\resources\\huddle-mcp.mjs';
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    expect(huddleMcpConfig({ serverScript: script, nodeCommand: node }).mcpServers.huddle).toEqual({
      type: 'stdio',
      command: node,
      args: [script],
    });
  });

  it.each([
    ['', 'empty'],
    ['scripts/huddle-mcp.mjs', 'relative'],
    ['-e', 'a flag'],
    ['C:/x/huddle-mcp.txt', 'not a script'],
    ['C:/x/huddle\nmcp.mjs', 'a control character'],
    [`C:/${'x'.repeat(2000)}.mjs`, 'too long'],
  ])('refuses a server script that is %j (%s)', (serverScript) => {
    expect(() => huddleMcpConfig({ serverScript })).toThrow(/invalid server script/);
  });

  it.each(['', 'nodejs', 'node --inspect', '-e'])('refuses node command %j', (nodeCommand) => {
    expect(() => huddleMcpConfig({ serverScript: SCRIPT, nodeCommand })).toThrow(/invalid node command/);
  });

  it('allows exactly the two huddle tools, nothing broader', () => {
    expect(huddleMcpPermissionsAllow()).toEqual(['mcp__huddle__report_progress', 'mcp__huddle__report_teammate']);
    expect(HUDDLE_TEAMMATE_TOOL).toBe('mcp__huddle__report_teammate');
  });

  it('the prompt line asks for reports at the start, after each major step and before finishing', () => {
    expect(HUDDLE_PROGRESS_PROMPT_LINE).toMatch(/report_progress/);
    expect(HUDDLE_PROGRESS_PROMPT_LINE).toMatch(/at the start/);
    expect(HUDDLE_PROGRESS_PROMPT_LINE).toMatch(/after each major step/);
    expect(HUDDLE_PROGRESS_PROMPT_LINE).toMatch(/before you finish/);
  });

  it('appends the line once, on its own paragraph', () => {
    const once = withProgressPromptLine('Fix the bug.  \n');
    expect(once).toBe(`Fix the bug.\n\n${HUDDLE_PROGRESS_PROMPT_LINE}`);
    expect(withProgressPromptLine(once)).toBe(once);
    expect(withProgressPromptLine('')).toBe(HUDDLE_PROGRESS_PROMPT_LINE);
  });
});

describe('huddle MCP launcher and installer pieces (M6 P4, ADR-025)', () => {
  it('adds the tool to agents with a tools list only, once, without mutating the template', () => {
    const agents = {
      reader: { description: 'r', prompt: 'p', tools: ['Read'] },
      open: { description: 'o', prompt: 'p' },
      already: { description: 'a', prompt: 'p', tools: ['Read', HUDDLE_PROGRESS_TOOL] },
    };
    const out = withProgressTool(agents);
    expect(out.reader?.tools).toEqual(['Read', HUDDLE_PROGRESS_TOOL]);
    expect(out.open).toEqual({ description: 'o', prompt: withProgressPromptLine('p') });
    expect(out.already?.tools).toEqual(['Read', HUDDLE_PROGRESS_TOOL]);
    expect(agents.reader.tools).toEqual(['Read']);
    // Every agent's own prompt asks for reports too (a subagent never sees the main prompt), once.
    for (const a of Object.values(out)) expect(a.prompt).toBe(`p\n\n${HUDDLE_PROGRESS_PROMPT_LINE}`);
    expect(withProgressTool(out).reader?.prompt).toBe(out.reader?.prompt);
    expect(agents.reader.prompt).toBe('p');
  });

  it('per-run settings: only the allow entry for the product; a harness file is kept and the entry added once', () => {
    expect(JSON.parse(progressRunSettingsJson(null))).toEqual({
      permissions: { allow: [HUDDLE_PROGRESS_TOOL, HUDDLE_TEAMMATE_TOOL] },
    });
    const harness = {
      hooks: { Stop: [] },
      permissions: { allow: ['Read', HUDDLE_PROGRESS_TOOL, HUDDLE_TEAMMATE_TOOL], deny: ['Bash'] },
    };
    expect(JSON.parse(progressRunSettingsJson(harness))).toEqual(harness);
    expect(JSON.parse(progressRunSettingsJson({ env: { A: '1' } }))).toEqual({
      env: { A: '1' },
      permissions: { allow: [HUDDLE_PROGRESS_TOOL, HUDDLE_TEAMMATE_TOOL] },
    });
    expect(() => progressRunSettingsJson([1])).toThrow();
  });

  it('claude mcp add / remove argv: the server command after --, never a shell string', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    expect(mcpAddArgs({ serverScript: SCRIPT, nodeCommand: node })).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      'huddle',
      '--',
      node,
      SCRIPT,
    ]);
    expect(mcpRemoveArgs()).toEqual(['mcp', 'remove', '--scope', 'user', 'huddle']);
    expect(() => mcpAddArgs({ serverScript: '--evil.mjs' })).toThrow();
  });

  it("reads only mcpServers.huddle from .claude.json and tells ours from the user's", () => {
    const ours = { type: 'stdio', command: 'node', args: [SCRIPT], env: {} };
    expect(userScopeHuddleServer({ mcpServers: { huddle: ours }, oauthAccount: { x: 1 } })).toEqual(ours);
    expect(userScopeHuddleServer({ mcpServers: { other: {} } })).toBeUndefined();
    expect(userScopeHuddleServer({})).toBeUndefined();
    expect(userScopeHuddleServer('nope')).toBeUndefined();
    expect(isHuddleServerEntry(ours, SCRIPT)).toBe(true);
    // Slash direction and case do not matter on Windows paths.
    expect(isHuddleServerEntry({ command: 'node', args: [SCRIPT.replace(/\//g, '\\').toUpperCase()] }, SCRIPT)).toBe(
      true,
    );
    expect(isHuddleServerEntry({ command: 'node', args: [SCRIPT, '--x'] }, SCRIPT)).toBe(false);
    expect(isHuddleServerEntry({ command: 'python', args: ['other.py'] }, SCRIPT)).toBe(false);
    expect(isHuddleServerEntry({ type: 'http', url: 'https://x' }, SCRIPT)).toBe(false);
    expect(isHuddleServerEntry(undefined, SCRIPT)).toBe(false);
  });
});
