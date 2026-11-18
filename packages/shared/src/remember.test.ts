import { describe, expect, it } from 'vitest';
import { priorKey } from './model.js';
import { DEFAULT_RETENTION_DAYS, RETENTION_DAYS_MAX, RETENTION_DAYS_MIN } from './remember.js';
import { DEFAULT_USER_SETTINGS, applyUserSettingsPatch } from './settings.js';

describe('M5 settings', () => {
  it('defaults: 30 days of history, Ask off, no nicknames', () => {
    expect(DEFAULT_USER_SETTINGS.history).toEqual({ retentionDays: DEFAULT_RETENTION_DAYS });
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    expect(DEFAULT_RETENTION_DAYS).toBeGreaterThanOrEqual(RETENTION_DAYS_MIN);
    expect(DEFAULT_RETENTION_DAYS).toBeLessThanOrEqual(RETENTION_DAYS_MAX);
    expect(DEFAULT_USER_SETTINGS.ask).toEqual({ enabled: false });
    expect(DEFAULT_USER_SETTINGS.nicknames).toEqual({});
  });

  it('a settings.update patch carries history, ask and nicknames over unchanged and copies them', () => {
    const before = {
      ...DEFAULT_USER_SETTINGS,
      history: { retentionDays: 7 },
      ask: { enabled: true },
      nicknames: { 's1::a1': 'Tokenizer' },
    };
    const after = applyUserSettingsPatch(before, { widgetCollapsed: true });
    expect(after.history).toEqual({ retentionDays: 7 });
    expect(after.ask).toEqual({ enabled: true });
    expect(after.nicknames).toEqual({ 's1::a1': 'Tokenizer' });
    expect(after.nicknames).not.toBe(before.nicknames);
  });
});

describe('priorKey', () => {
  it('is unambiguous and never a prototype key', () => {
    expect(priorKey('a', 'b')).not.toBe(priorKey('a,b', null));
    expect(priorKey('main', null)).not.toBe(priorKey('main', 'null'));
    expect(priorKey('__proto__', null).startsWith('[')).toBe(true);
    const table: Record<string, number> = { [priorKey('Explore', 'claude-haiku-5-5')]: 66_000 };
    expect(table[priorKey('Explore', 'claude-haiku-5-5')]).toBe(66_000);
  });
});
