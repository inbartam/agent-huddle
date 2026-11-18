/**
 * Test helper: read the recorded, scrubbed payloads in the repo's `fixtures/` folder.
 * Used by ingest and normalize tests; not exported from the package.
 *
 * Each fixture line has the recorded log format `{t, kind, event, payload}` (see fixtures/README.md).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FixtureLine {
  /** ISO timestamp of when the recorder received the line. */
  t: string;
  /** `hook`, `otlp-logs`, `otlp-metrics` or `otlp-traces`. */
  kind: string;
  /** Hook event name; `null` on telemetry lines. */
  event: string | null;
  payload: unknown;
}

/** Absolute path of the repo's `fixtures/` folder (packages/core/src/test → repo root). */
export const FIXTURES_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', 'fixtures');

/**
 * Status line fixtures (`statusline-*.jsonl`, F9) hold only `kind: "statusline"` lines: no hooks, no telemetry. The
 * hook and telemetry suites expect both in every fixture, so these files are listed separately.
 */
export const STATUSLINE_FIXTURE_PREFIX = 'statusline-';

/**
 * Stream fixtures (`stream-*.jsonl`, M4) hold only `kind: "stream"` lines: one stdout line of a managed stream-json run
 * per line, as `payload`. Listed separately for the same reason as the status line fixtures.
 */
export const STREAM_FIXTURE_PREFIX = 'stream-';

/** Every hook and telemetry `*.jsonl` fixture file name, sorted. Discovered at run time so new fixtures are picked up. */
export function listFixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter(
      (name) =>
        name.endsWith('.jsonl') &&
        !name.startsWith(STATUSLINE_FIXTURE_PREFIX) &&
        !name.startsWith(STREAM_FIXTURE_PREFIX),
    )
    .sort();
}

/** Every stream fixture (`stream-*.jsonl`), sorted. */
export function listStreamFixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.jsonl') && name.startsWith(STREAM_FIXTURE_PREFIX))
    .sort();
}

/**
 * Hook fixtures recorded without telemetry (no OTLP exporter in that run). The telemetry suites require at least one
 * `api_request` per fixture, which guards against a scrub that drops every record, so these few are named here and
 * skipped there only. `tasks-enabled.jsonl`: spike S4b, task hooks with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.
 * `mcp-progress.jsonl`: spike S19 (e2), MCP progress reports by the main agent and a subagent (F27).
 * `agent-team.jsonl`: spike S20 (b), an interactive agent team of two teammates (M6). `agent-team-report.jsonl`: the same
 * run with the lead's report_teammate answers added (M6 P5b; derived, not recorded).
 */
export const HOOKS_ONLY_FIXTURES: ReadonlySet<string> = new Set([
  'tasks-enabled.jsonl',
  'mcp-progress.jsonl',
  'agent-team.jsonl',
  'agent-team-report.jsonl',
]);

/**
 * Fixtures whose recording kept no `tool_response` (the recorder dropped every one), so their `PostToolUse(Agent)`
 * lines carry no agentId and give no agent.linked. `agent-team.jsonl`: spike S20 (b), the only recorded agent team.
 */
export const NO_AGENT_LINK_FIXTURES: ReadonlySet<string> = new Set(['agent-team.jsonl', 'agent-team-report.jsonl']);

/** The hook fixtures that also carry telemetry: every `listFixtureFiles()` entry except `HOOKS_ONLY_FIXTURES`. */
export function listTelemetryFixtureFiles(): string[] {
  return listFixtureFiles().filter((name) => !HOOKS_ONLY_FIXTURES.has(name));
}

/** Every status line fixture (`statusline-*.jsonl`), sorted. */
export function listStatuslineFixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.jsonl') && name.startsWith(STATUSLINE_FIXTURE_PREFIX))
    .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one fixture line. Throws with the line number on a malformed line: a broken fixture should fail loudly. */
export function parseFixtureLine(line: string, where = 'fixture line'): FixtureLine {
  const raw: unknown = JSON.parse(line);
  if (
    !isRecord(raw) ||
    typeof raw.t !== 'string' ||
    typeof raw.kind !== 'string' ||
    (typeof raw.event !== 'string' && raw.event !== null)
  ) {
    throw new Error(`${where}: expected {t, kind, event, payload}`);
  }
  return { t: raw.t, kind: raw.kind, event: typeof raw.event === 'string' ? raw.event : null, payload: raw.payload };
}

/** All lines of one fixture file (by name, e.g. `single-agent.jsonl`). Blank lines are skipped. */
export function readFixture(name: string): FixtureLine[] {
  const text = readFileSync(join(FIXTURES_DIR, name), 'utf8');
  const lines: FixtureLine[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    lines.push(parseFixtureLine(line, `${name}:${String(index + 1)}`));
  });
  return lines;
}
