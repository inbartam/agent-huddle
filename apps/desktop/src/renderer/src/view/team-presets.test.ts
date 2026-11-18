import { describe, expect, it } from 'vitest';
import { roleKindOf } from '@huddle/shared';
import { validateDraft } from './launch.js';
import { MEMBER_KINDS, READ_ONLY_TOOLS, TEAM_PRESETS, typedTeam, typedTeamDraft } from './team-presets.js';

describe('typed team presets', () => {
  it('names each member so roleKindOf gives its kind back, from the name alone', () => {
    const team = typedTeam(MEMBER_KINDS);
    expect(Object.keys(team.agents)).toEqual([...MEMBER_KINDS]);
    for (const kind of MEMBER_KINDS) {
      const name = Object.keys(team.agents).find((n) => roleKindOf(n) === kind);
      expect(name, kind).toBe(kind);
      expect(roleKindOf(kind, null)).toBe(kind);
    }
  });

  it('gives reviewers, researchers and planners read-only tools and everyone else every tool', () => {
    const { agents } = typedTeam(MEMBER_KINDS);
    for (const k of ['reviewer', 'researcher', 'planner']) expect(agents[k]?.tools).toEqual([...READ_ONLY_TOOLS]);
    for (const k of ['builder', 'designer', 'tester', 'writer']) expect(agents[k]?.tools).toBeUndefined();
    expect(READ_ONLY_TOOLS).toEqual(['Read', 'Grep', 'Glob']);
  });

  it("the lead's prompt names every member and the review loop", () => {
    for (const preset of TEAM_PRESETS) {
      const { prompt, agents } = typedTeam(preset.kinds);
      for (const name of Object.keys(agents)) expect(prompt, preset.id).toContain(`the ${name}`);
      expect(prompt).toMatch(/report/i);
    }
    const br = typedTeam(['builder', 'reviewer']).prompt;
    expect(br).toContain("Send the reviewer's findings back to the builder");
    expect(br).toContain('until the reviewer approves');
    const all = typedTeam(MEMBER_KINDS).prompt;
    for (const k of MEMBER_KINDS) expect(all).toContain(`the ${k}`);
  });

  it('drops unknown kinds, the lead and repeats, and keeps work order', () => {
    expect(Object.keys(typedTeam(['reviewer', 'lead', 'general', 'builder', 'reviewer', 'x']).agents)).toEqual([
      'builder',
      'reviewer',
    ]);
  });

  it('every member has a one-line description and a prompt', () => {
    for (const a of Object.values(typedTeam(MEMBER_KINDS).agents)) {
      expect(a.description).not.toBe('');
      expect(a.description).not.toContain('\n');
      expect(a.prompt.length).toBeGreaterThan(40);
    }
  });

  it('the draft leaves the folder empty and is otherwise valid', () => {
    for (const preset of TEAM_PRESETS) {
      const draft = typedTeamDraft(preset.kinds);
      expect(draft.cwd).toBe('');
      expect(draft.name).not.toBe('');
      expect(draft.agents.map((a) => a.name)).toEqual(
        [...preset.kinds].sort((x, y) => MEMBER_KINDS.indexOf(x) - MEMBER_KINDS.indexOf(y)),
      );
      expect(validateDraft(draft, true)).toEqual({ cwd: 'Choose the folder the run works in.' });
    }
    expect(typedTeamDraft(['builder', 'reviewer']).agents.find((a) => a.name === 'reviewer')?.tools).toBe(
      'Read, Grep, Glob',
    );
  });
});
