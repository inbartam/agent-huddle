/**
 * False-positive guard (F21): every recorded fixture, normalized the way the servers do it, goes through the
 * detectors with a tick at each event's ts (as the live timer would see it). None of these runs had a loop, a file
 * conflict or a stuck agent, so none may raise an item.
 *
 * One adjustment: the fixture scrubber replaces free text with the same placeholder "(scrubbed text)", so distinct
 * inputs (five Agent calls with five different briefs) hash to one inputDigest. A tool start whose input was scrubbed
 * gets a digest of its own here. The second test pins exactly what that adjustment hides, so it cannot mask a real loop.
 */
import type { HuddleEvent } from '@huddle/shared';
import { describe, expect, it } from 'vitest';
import { listFixtureFiles } from '../test/fixtures.js';
import { fixtureEvents } from '../test/replay-fixture.js';
import { listRunFixtures } from '../test/run-fixtures.js';
import { DEFAULTS, raisedIds, run } from '../test/detect-events.js';

const SCRUBBED = '(scrubbed text)';
const files = [...listFixtureFiles(), ...listRunFixtures().map((r) => r.file)];

function unscrub(events: readonly HuddleEvent[]): HuddleEvent[] {
  return events.map((e) =>
    e.type === 'tool.started' && e.summary.includes(SCRUBBED)
      ? { ...e, inputDigest: `scrubbed:${e.toolUseId ?? e.id}` }
      : e,
  );
}

describe('detectors over recorded fixtures', () => {
  it('finds fixtures to replay', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)('%s raises no loop, conflict or stuck item', (name) => {
    const { emitted } = run(unscrub(fixtureEvents(name)), DEFAULTS, { tickAtEachEvent: true });
    expect(raisedIds(emitted)).toEqual([]);
  });

  // The scrubber replaces free text (Agent prompts, Glob/Grep patterns) with one placeholder, so distinct calls can share a
  // digest after scrubbing. Any raise must come from such calls; the test above proves none remain once they are told apart.
  it.each(files)('%s: without the adjustment, only repeats of scrubbed calls raise', (name) => {
    const events = fixtureEvents(name);
    const { emitted } = run(events, DEFAULTS, { tickAtEachEvent: true });
    for (const e of emitted) {
      if (e.type !== 'attention.raised') continue;
      expect(e.item.kind).toBe('loop');
      const digest = e.item.id.slice(e.item.id.lastIndexOf(':') + 1);
      const starts = events.filter((x) => x.type === 'tool.started' && x.inputDigest === digest);
      expect(starts.length).toBeGreaterThan(0);
      for (const s of starts) {
        if (s.type !== 'tool.started') continue;
        expect(s.summary).toContain(SCRUBBED);
      }
    }
  });

  it.each(files)('%s replays deterministically into JSON-safe state', (name) => {
    const events = fixtureEvents(name);
    const a = run(events, DEFAULTS, { tickAtEachEvent: true });
    const b = run(events, DEFAULTS, { tickAtEachEvent: true });
    expect(a.emitted).toEqual(b.emitted);
    expect(JSON.parse(JSON.stringify(a.state))).toEqual(a.state);
  });
});
