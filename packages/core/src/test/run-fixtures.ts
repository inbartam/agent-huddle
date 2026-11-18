/**
 * Test helper: the recorded headless runs in `fixtures/runs/<promptId>.jsonl` (scrubbed recordings) and the group
 * ('tune' or 'judge') each prompt belongs to, read from scripts/lib/run-prompts.mjs. Not exported from the package.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_DIR } from './fixtures.js';

export type RunGroup = 'tune' | 'judge';

export interface RunFixture {
  id: string;
  group: RunGroup | 'unknown';
  /** Name for `readFixture` / `fixtureEvents` / `rawApiRequests`, relative to the fixtures folder. */
  file: string;
}

const PROMPTS_FILE = join(FIXTURES_DIR, '..', 'scripts', 'lib', 'run-prompts.mjs');

function promptGroups(): Map<string, RunGroup> {
  const groups = new Map<string, RunGroup>();
  const text = readFileSync(PROMPTS_FILE, 'utf8');
  for (const m of text.matchAll(/\bp\('([^']+)',\s*'(tune|judge)'/g)) {
    groups.set(m[1] as string, m[2] as RunGroup);
  }
  return groups;
}

/** Every recorded run, sorted by id. Empty when `fixtures/runs` does not exist or holds no runs. */
export function listRunFixtures(): RunFixture[] {
  const dir = join(FIXTURES_DIR, 'runs');
  if (!existsSync(dir)) return [];
  const groups = promptGroups();
  return (
    readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      // HUDDLE_RUNS=base: only the first 15 recorded runs (no `.sub-<model>` batch), for before/after comparisons (m5:exit).
      .filter((name) => process.env.HUDDLE_RUNS !== 'base' || !/.sub-[a-z0-9-]+.jsonl$/.test(name))
      .sort()
      .map((name) => {
        const id = name.replace(/\.jsonl$/, '');
        // A batch recorded with --subagent-model names its runs <promptId>.sub-<model>.jsonl.
        const promptId = id.replace(/\.sub-[a-z0-9-]+$/, '');
        return { id, group: groups.get(promptId) ?? 'unknown', file: `runs/${name}` };
      })
  );
}
