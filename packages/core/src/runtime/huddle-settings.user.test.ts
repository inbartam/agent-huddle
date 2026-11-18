import { describe, expect, it } from 'vitest';
import { applyUserSettingsPatch, DEFAULT_USER_SETTINGS } from '@huddle/shared';
import {
  parseHuddleSettings,
  parseUserSettings,
  serializeHuddleSettings,
  USER_SETTINGS_KEY,
  userSettingsOf,
  userSettingsPatchSchema,
  withUserSettings,
} from './huddle-settings.js';

describe('user settings in huddle-settings.json (M3)', () => {
  it('reads defaults from nothing, junk, or a file written before M3', () => {
    expect(parseUserSettings(undefined)).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings('nope')).toEqual(DEFAULT_USER_SETTINGS);
    expect(parseUserSettings([1, 2])).toEqual(DEFAULT_USER_SETTINGS);
    expect(userSettingsOf(parseHuddleSettings('{"consentedAt": null}'))).toEqual(DEFAULT_USER_SETTINGS);
    expect(userSettingsOf(parseHuddleSettings(null))).toEqual(DEFAULT_USER_SETTINGS);
  });

  it('falls back field by field: one bad value does not reset the others', () => {
    const parsed = parseUserSettings({
      detectors: { stuckMinutes: 9, loopRepeat: 0, loopFailures: 'three' },
      toasts: { stuck: false, loop: 'yes' },
      questionHoldSeconds: 9999,
      globalShortcut: 'Control+Shift+K',
    });
    expect(parsed.detectors).toEqual({ ...DEFAULT_USER_SETTINGS.detectors, stuckMinutes: 9 });
    expect(parsed.toasts).toEqual({ ...DEFAULT_USER_SETTINGS.toasts, stuck: false });
    expect(parsed.questionHoldSeconds).toBe(DEFAULT_USER_SETTINGS.questionHoldSeconds);
    expect(parsed.globalShortcut).toBe('Control+Shift+K');
  });

  it('reads widgetCollapsed: false for a file written before it existed, the saved boolean otherwise', () => {
    const old = parseHuddleSettings('{"preferences": {"questionHoldSeconds": 60}}');
    expect(userSettingsOf(old).widgetCollapsed).toBe(false);
    expect(userSettingsOf(old).questionHoldSeconds).toBe(60);
    const saved = serializeHuddleSettings(withUserSettings(old, { ...userSettingsOf(old), widgetCollapsed: true }));
    expect(userSettingsOf(parseHuddleSettings(saved)).widgetCollapsed).toBe(true);
    expect(parseUserSettings({ widgetCollapsed: 'yes' }).widgetCollapsed).toBe(false);
  });

  it('reads policy.applyToAttached: false for a file written before M4, the saved boolean otherwise (ADR-020 §3)', () => {
    const old = parseHuddleSettings('{"preferences": {"questionHoldSeconds": 60}}');
    expect(userSettingsOf(old).policy).toEqual({ applyToAttached: false });
    const saved = serializeHuddleSettings(
      withUserSettings(old, { ...userSettingsOf(old), policy: { applyToAttached: true } }),
    );
    expect(userSettingsOf(parseHuddleSettings(saved)).policy.applyToAttached).toBe(true);
    expect(parseUserSettings({ policy: { applyToAttached: 'yes' } }).policy.applyToAttached).toBe(false);
    expect(parseUserSettings({ policy: 'on' }).policy.applyToAttached).toBe(false);
    expect(userSettingsPatchSchema.safeParse({ policy: { applyToAttached: true } }).success).toBe(true);
    expect(userSettingsPatchSchema.safeParse({ policy: { applyToAttached: 1 } }).success).toBe(false);
  });

  it('round-trips through the file and keeps consent and unknown fields', () => {
    const file = parseHuddleSettings(
      '{"consentedAt": "2026-11-13T10:00:00.000Z", "consentedFor": "C:/cfg/settings.json", "later": {"x": 1}}',
    );
    const user = { ...DEFAULT_USER_SETTINGS, questionHoldSeconds: 45 };
    const text = serializeHuddleSettings(withUserSettings(file, user));
    const back = parseHuddleSettings(text);
    expect(back.consentedAt).toBe('2026-11-13T10:00:00.000Z');
    expect(back.extra.later).toEqual({ x: 1 });
    expect(USER_SETTINGS_KEY in back.extra).toBe(true);
    expect(userSettingsOf(back)).toEqual(user);
  });

  it('checks a settings.update patch: any subset, in range, unknown fields kept, never throws', () => {
    const ok = userSettingsPatchSchema.safeParse({ toasts: { question: false }, future: 1 });
    expect(ok.success).toBe(true);
    expect(ok.data).toEqual({ toasts: { question: false }, future: 1 });
    expect(userSettingsPatchSchema.safeParse({}).success).toBe(true);
    for (const bad of [
      { detectors: { stuckMinutes: 0 } },
      { detectors: { loopRepeat: 2.5 } },
      { toasts: { approval: 'no' } },
      { questionHoldSeconds: -1 },
      { questionHoldSeconds: 600 },
      { globalShortcut: '' },
      { globalShortcut: 'Control Alt H' },
      { widgetCollapsed: 'yes' },
      { widgetCollapsed: 1 },
      null,
      'x',
    ]) {
      expect(userSettingsPatchSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('selfReport setting (M6, F27)', () => {
  it('defaults to on; a file without it, or with a bad value, reads as on', () => {
    expect(DEFAULT_USER_SETTINGS.selfReport).toEqual({ enabled: true });
    expect(parseUserSettings({}).selfReport).toEqual({ enabled: true });
    expect(parseUserSettings({ selfReport: { enabled: 'no' } }).selfReport).toEqual({ enabled: true });
    expect(parseUserSettings({ selfReport: { enabled: false } }).selfReport).toEqual({ enabled: false });
  });

  it('is patchable with settings.update and checked', () => {
    expect(userSettingsPatchSchema.safeParse({ selfReport: { enabled: false } }).success).toBe(true);
    expect(userSettingsPatchSchema.safeParse({ selfReport: { enabled: 1 } }).success).toBe(false);
    const off = parseUserSettings(applyUserSettingsPatch(DEFAULT_USER_SETTINGS, { selfReport: { enabled: false } }));
    expect(off.selfReport).toEqual({ enabled: false });
    // Another patch keeps it.
    expect(applyUserSettingsPatch(off, { widgetCollapsed: true }).selfReport).toEqual({ enabled: false });
  });
});

describe('teams.askLeadOnIdle setting (M6 P5b, ADR-027)', () => {
  it('defaults to on; a file without it, or with a bad value, reads as on', () => {
    expect(DEFAULT_USER_SETTINGS.teams).toEqual({ askLeadOnIdle: true });
    expect(parseUserSettings({}).teams).toEqual({ askLeadOnIdle: true });
    expect(parseUserSettings({ teams: { askLeadOnIdle: 'no' } }).teams).toEqual({ askLeadOnIdle: true });
    expect(parseUserSettings({ teams: 3 }).teams).toEqual({ askLeadOnIdle: true });
    expect(parseUserSettings({ teams: { askLeadOnIdle: false } }).teams).toEqual({ askLeadOnIdle: false });
  });

  it('is patchable with settings.update and checked; other patches keep it', () => {
    expect(userSettingsPatchSchema.safeParse({ teams: { askLeadOnIdle: false } }).success).toBe(true);
    expect(userSettingsPatchSchema.safeParse({ teams: { askLeadOnIdle: 'off' } }).success).toBe(false);
    const off = parseUserSettings(applyUserSettingsPatch(DEFAULT_USER_SETTINGS, { teams: { askLeadOnIdle: false } }));
    expect(off.teams).toEqual({ askLeadOnIdle: false });
    expect(applyUserSettingsPatch(off, { widgetCollapsed: true }).teams).toEqual({ askLeadOnIdle: false });
    expect(applyUserSettingsPatch(off, { teams: {} }).teams).toEqual({ askLeadOnIdle: false });
  });
});
