import { describe, expect, it } from 'vitest';
import { ASK_SYSTEM_PROMPT, buildAskArgs, looksNotLoggedIn, parseAskResult } from './ask-cli.js';

describe('buildAskArgs', () => {
  it('is the S18 recommended command, with --tools as one empty element and no --bare', () => {
    expect(buildAskArgs()).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--disallowedTools',
      'mcp__*',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--settings',
      '{"disableAllHooks":true,"autoMemoryEnabled":false,"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"0","OTEL_LOGS_EXPORTER":"none","OTEL_METRICS_EXPORTER":"none","OTEL_EXPORTER_OTLP_ENDPOINT":"http://127.0.0.1:9"}}',
      '--system-prompt',
      ASK_SYSTEM_PROMPT,
    ]);
    expect(buildAskArgs()).not.toContain('--bare');
  });
});

describe('parseAskResult', () => {
  const ok = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'hello',
    session_id: 's1',
    duration_api_ms: 700,
    total_cost_usd: 0.001,
    usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 9 },
    modelUsage: { 'claude-haiku-5-5': {} },
    extra_field: { kept: true },
  };

  it('reads a success result', () => {
    expect(parseAskResult(`${JSON.stringify(ok)}\n`)).toEqual({
      success: true,
      text: 'hello',
      subtype: 'success',
      sessionId: 's1',
      model: 'claude-haiku-5-5',
      apiMs: 700,
      costUsd: 0.001,
      tokens: { input: 125, output: 9 },
      apiErrorStatus: null,
    });
  });

  it('finds the result line after other lines', () => {
    expect(parseAskResult(`warning\n{"x":1}\n${JSON.stringify(ok)}\n`)?.text).toBe('hello');
  });

  it('reads an error result (errors joined) and leaves missing numbers unknown', () => {
    const facts = parseAskResult(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['a', { message: 'b' }] }),
    );
    expect(facts).toMatchObject({
      success: false,
      text: 'a; b',
      subtype: 'error_max_turns',
      tokens: null,
      model: null,
      costUsd: null,
    });
  });

  it('is_error true is never a success, even with subtype success', () => {
    expect(parseAskResult(JSON.stringify({ ...ok, is_error: true }))?.success).toBe(false);
  });

  it('returns null for no result and never throws on odd shapes', () => {
    expect(parseAskResult('')).toBeNull();
    expect(parseAskResult('not json')).toBeNull();
    expect(parseAskResult('[1,2]')).toBeNull();
    expect(parseAskResult('{"type":"assistant"}')).toBeNull();
    expect(parseAskResult(JSON.stringify({ type: 'result', usage: 'x' }))).toBeNull();
  });
});

describe('looksNotLoggedIn', () => {
  it('matches only unambiguous phrases or HTTP 401', () => {
    expect(looksNotLoggedIn('Not logged in · Please run /login')).toBe(true);
    expect(looksNotLoggedIn('Invalid API key · Fix external API key')).toBe(true);
    expect(looksNotLoggedIn('OAuth token has expired')).toBe(true);
    expect(looksNotLoggedIn('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}')).toBe(true);
    expect(looksNotLoggedIn('API Error', 401)).toBe(true);
    expect(looksNotLoggedIn('overloaded_error')).toBe(false);
    expect(looksNotLoggedIn('the agent is logged in to the database')).toBe(false);
    expect(looksNotLoggedIn('API Error', 500)).toBe(false);
  });
});
