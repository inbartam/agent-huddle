import { describe, expect, it } from 'vitest';
import { applyUserSettingsPatch, DEFAULT_USER_SETTINGS } from './settings.js';

describe('user settings', () => {
  it('has the M3, M4, M5 and M6 defaults and survives a JSON round trip', () => {
    expect(DEFAULT_USER_SETTINGS).toEqual({
      detectors: {
        stuckMinutes: 5,
        stuckOpenToolMinutes: 15,
        loopRepeat: 5,
        loopFailures: 3,
        conflictWindowMinutes: 10,
      },
      toasts: {
        approval: true,
        question: true,
        stuck: true,
        loop: true,
        conflict: true,
        doneOrError: true,
        budget: true,
        roleDrift: true,
      },
      questionHoldSeconds: 120,
      globalShortcut: 'Control+Alt+H',
      widgetCollapsed: false,
      // ADR-020 §3: rules apply to managed sessions only until S15 is run.
      policy: { applyToAttached: false },
      // M5: 30 days of history, Ask the Huddle off (owner decisions), no nicknames kept yet.
      history: { retentionDays: 30 },
      ask: { enabled: false },
      nicknames: {},
      // M6 (F26): no address chosen yet; phone access itself is not a setting (always off at start).
      phone: { ip: null, port: 47835 },
      // M6 (F27): self-reported progress for managed runs, on (ADR-025).
      selfReport: { enabled: true },
      // M6 P5b (ADR-027): ask the lead about idle teammates, on.
      teams: { askLeadOnIdle: true },
      roleKinds: {},
    });
    expect(JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS))).toEqual(DEFAULT_USER_SETTINGS);
  });

  it('patches policy.applyToAttached without touching the rest', () => {
    const on = applyUserSettingsPatch(DEFAULT_USER_SETTINGS, { policy: { applyToAttached: true } });
    expect(on.policy).toEqual({ applyToAttached: true });
    expect(applyUserSettingsPatch(on, { questionHoldSeconds: 30 }).policy.applyToAttached).toBe(true);
    expect(applyUserSettingsPatch(on, { policy: {} }).policy.applyToAttached).toBe(true);
    expect(DEFAULT_USER_SETTINGS.policy.applyToAttached).toBe(false);
  });

  it('applies a partial patch without touching the rest or mutating its inputs', () => {
    const before: unknown = JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
    const next = applyUserSettingsPatch(DEFAULT_USER_SETTINGS, {
      detectors: { loopRepeat: 7 },
      toasts: { stuck: false },
      questionHoldSeconds: 30,
    });
    expect(next.detectors).toEqual({ ...DEFAULT_USER_SETTINGS.detectors, loopRepeat: 7 });
    expect(next.toasts).toEqual({ ...DEFAULT_USER_SETTINGS.toasts, stuck: false });
    expect(next.questionHoldSeconds).toBe(30);
    expect(next.globalShortcut).toBe('Control+Alt+H');
    expect(DEFAULT_USER_SETTINGS).toEqual(before);
    expect(applyUserSettingsPatch(DEFAULT_USER_SETTINGS, {})).toEqual(DEFAULT_USER_SETTINGS);
  });

  it('collapses the widget through a patch and keeps it collapsed when another field changes', () => {
    const collapsed = applyUserSettingsPatch(DEFAULT_USER_SETTINGS, { widgetCollapsed: true });
    expect(collapsed.widgetCollapsed).toBe(true);
    expect(applyUserSettingsPatch(collapsed, { questionHoldSeconds: 30 }).widgetCollapsed).toBe(true);
    expect(applyUserSettingsPatch(collapsed, { widgetCollapsed: false }).widgetCollapsed).toBe(false);
  });
});
