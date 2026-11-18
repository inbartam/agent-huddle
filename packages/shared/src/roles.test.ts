import { describe, expect, it } from 'vitest';
import { applyUserSettingsPatch, DEFAULT_USER_SETTINGS } from './settings.js';
import { priorKey } from './model.js';
import { ROLE_KINDS, ROLE_PROFILES, roleKindOf, withRoleKind } from './roles.js';
import { priorMsFor } from './selectors.js';

describe('roleKindOf: the guess', () => {
  // Role names that really ran on the owner's machine, and agent definitions they have installed.
  it.each([
    ['oh-my-claudecode:code-reviewer', 'reviewer'],
    ['security-reviewer', 'reviewer'],
    ['review', 'reviewer'],
    ['checker', 'reviewer'],
    ['Reality Checker', 'reviewer'],
    ['test-engineer', 'tester'],
    ['ui-engineer', 'designer'],
    ['UI Designer', 'designer'],
    ['huddle-architect', 'planner'],
    ['Plan', 'planner'],
    ['Explore', 'researcher'],
    ['reader', 'researcher'],
    ['lister', 'researcher'],
    ['Technical Writer', 'writer'],
    ['core-engineer', 'builder'],
    ['oh-my-claudecode:executor', 'builder'],
    ['fixes', 'builder'],
    ['wp2-migrate', 'builder'],
    ['ml1-lead', 'lead'],
    ['Agents Orchestrator', 'lead'],
    ['Senior Project Manager', 'lead'],
    ['general-purpose', 'general'],
    ['main', 'general'],
    ['statusline-setup', 'general'],
  ])('%s is a %s', (role, kind) => {
    expect(roleKindOf(role)).toBe(kind);
  });

  it('uses the description only when the name says nothing', () => {
    expect(roleKindOf('wp4a-contract', 'Reviews the API contract for breaking changes')).toBe('reviewer');
    // The name wins over a description that mentions reviewing in passing.
    expect(roleKindOf('core-engineer', 'Builds core code; asks for review when done')).toBe('builder');
  });

  it("the user's override wins, and clearing it goes back to the guess", () => {
    const set = withRoleKind({}, 'wp2-migrate', 'designer');
    expect(roleKindOf('wp2-migrate', null, set)).toBe('designer');
    expect(roleKindOf('wp2-migrate', null, withRoleKind(set, 'wp2-migrate', null))).toBe('builder');
  });

  it('never takes a prototype key as a role', () => {
    const set = withRoleKind({}, '__proto__', 'lead');
    expect(Object.keys(set)).toEqual([]);
    expect(roleKindOf('__proto__', null, set)).toBe('general');
  });

  it('every type has a profile', () => {
    for (const kind of ROLE_KINDS) expect(ROLE_PROFILES[kind].label.length).toBeGreaterThan(0);
  });
});

describe('settings.roleKinds', () => {
  it('a patch sets and clears single roles and keeps the rest', () => {
    const a = applyUserSettingsPatch(DEFAULT_USER_SETTINGS, { roleKinds: { x: 'tester', y: 'writer' } });
    const b = applyUserSettingsPatch(a, { roleKinds: { x: null } });
    expect(b.roleKinds).toEqual({ y: 'writer' });
  });
});

describe('ETA prior by type', () => {
  it('a role with no prior borrows the mean of its type on the same model; general never does', () => {
    const priors = {
      byRoleModel: {
        [priorKey('code-reviewer', 'm')]: 1000,
        [priorKey('security-reviewer', 'm')]: 3000,
        [priorKey('security-reviewer', 'other')]: 9000,
        [priorKey('Explore', 'm')]: 500,
      },
      asOf: 0,
    };
    expect(priorMsFor(priors, 'code-reviewer', 'm')).toBe(1000);
    expect(priorMsFor(priors, 'review-bot', 'm')).toBe(2000);
    expect(priorMsFor(priors, 'review-bot', 'nope')).toBeNull();
    expect(priorMsFor(priors, 'general-purpose', 'm')).toBeNull();
    // The user's type decides: call review-bot a researcher and it borrows Explore's.
    expect(priorMsFor(priors, 'review-bot', 'm', { 'review-bot': 'researcher' })).toBe(500);
  });
});
