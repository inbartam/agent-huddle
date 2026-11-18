import { describe, expect, it } from 'vitest';
import { CLIP_LIMITS, DEFAULT_USER_SETTINGS } from '@huddle/shared';
import { MAX_NICKNAMES, parseNicknames, parseUserSettings } from './huddle-settings.js';

describe('M5 user settings', () => {
  it('a file without the M5 fields loads the defaults', () => {
    const s = parseUserSettings({ widgetCollapsed: true });
    expect(s.history).toEqual({ retentionDays: 30 });
    expect(s.ask).toEqual({ enabled: false });
    expect(s.nicknames).toEqual({});
  });

  it('keeps valid values and falls back field by field', () => {
    expect(parseUserSettings({ history: { retentionDays: 7 }, ask: { enabled: true } })).toMatchObject({
      history: { retentionDays: 7 },
      ask: { enabled: true },
    });
    for (const bad of [0, 366, 2.5, '30', null]) {
      expect(parseUserSettings({ history: { retentionDays: bad } }).history.retentionDays).toBe(30);
    }
    expect(parseUserSettings({ ask: { enabled: 'yes' } }).ask.enabled).toBe(false);
    expect(parseUserSettings({ ask: 'on' }).ask.enabled).toBe(false);
  });

  it('round-trips the defaults', () => {
    expect(parseUserSettings(JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS)))).toEqual(DEFAULT_USER_SETTINGS);
  });
});

describe('parseNicknames', () => {
  it('keeps well-formed keys, trims and clips names, drops the rest', () => {
    const raw = JSON.parse(
      JSON.stringify({
        's1::a1': '  Tokenizer ',
        s2: 'Main two',
        '': 'empty key',
        '../x': 'path key',
        's3::a3': '   ',
        's4::a4': 42,
        's5::a5': 'x'.repeat(1000),
      }),
    ) as unknown;
    const out = parseNicknames(raw);
    expect(Object.keys(out).sort()).toEqual(['s1::a1', 's2', 's5::a5']);
    expect(out['s1::a1']).toBe('Tokenizer');
    expect(out['s5::a5']).toHaveLength(CLIP_LIMITS.summary);
  });

  it('ignores prototype keys and non-objects, and caps the count', () => {
    expect(parseNicknames(JSON.parse('{"__proto__": "x", "constructor": "y"}'))).toEqual({});
    expect(parseNicknames(['a'])).toEqual({});
    expect(parseNicknames(null)).toEqual({});
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_NICKNAMES + 10; i++) many[`s${String(i)}`] = 'n';
    expect(Object.keys(parseNicknames(many))).toHaveLength(MAX_NICKNAMES);
  });
});
