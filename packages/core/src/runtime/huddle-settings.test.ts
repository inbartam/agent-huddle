import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS } from '@huddle/shared';
import {
  parseHuddleSettings,
  parseUserSettings,
  readHuddleSettings,
  sameSettingsFile,
  writeHuddleSettings,
} from './huddle-settings.js';

const FP = 'a'.repeat(64);

describe('huddle-settings.json', () => {
  it('treats missing, broken or odd content as "no consent"', () => {
    expect(parseHuddleSettings(null).consentedAt).toBeNull();
    expect(parseHuddleSettings('{not json').consentedAt).toBeNull();
    expect(parseHuddleSettings('[1]').consentedAt).toBeNull();
    expect(parseHuddleSettings('{"consentedAt": true}').consentedAt).toBeNull();
    expect(parseHuddleSettings('{"consentedAt": "not a date"}').consentedAt).toBeNull();
    // Consent without the file it was given for (written before consentedFor existed) counts as none.
    expect(parseHuddleSettings('{"consentedAt": "2026-11-13T10:00:00.000Z"}').consentedAt).toBeNull();
    const ok = parseHuddleSettings(
      '﻿{"consentedAt": "2026-11-13T10:00:00.000Z", "consentedFor": "C:/cfg/settings.json"}',
    );
    expect(ok.consentedAt).toBe('2026-11-13T10:00:00.000Z');
    expect(ok.consentedFor).toBe('C:/cfg/settings.json');
  });

  it('compares settings files resolved, and case-insensitively on Windows', () => {
    expect(sameSettingsFile('C:/Users/u/.claude/settings.json', 'c:\\users\\U\\.claude\\settings.json', 'win32')).toBe(
      true,
    );
    expect(sameSettingsFile('C:/a/settings.json', 'C:/b/settings.json', 'win32')).toBe(false);
  });

  it('reads the consent fingerprint; a consent without one (older file) keeps consent but no fingerprint', () => {
    const base = { consentedAt: '2026-11-13T10:00:00.000Z', consentedFor: 'C:/cfg/settings.json' };
    expect(parseHuddleSettings(JSON.stringify({ ...base, consentedFingerprint: FP }))).toMatchObject({
      ...base,
      consentedFingerprint: FP,
    });
    const legacy = parseHuddleSettings(JSON.stringify(base));
    expect(legacy).toMatchObject({ ...base, consentedFingerprint: null });
    expect(legacy.extra).toEqual({});
    // Malformed: not 64 hex characters, or no valid consent around it.
    expect(
      parseHuddleSettings(JSON.stringify({ ...base, consentedFingerprint: 'abc' })).consentedFingerprint,
    ).toBeNull();
    expect(parseHuddleSettings(JSON.stringify({ consentedFingerprint: FP })).consentedFingerprint).toBeNull();
  });

  it('parses an empty value to exactly the defaults (A2-07)', () => {
    expect(parseUserSettings({})).toEqual(DEFAULT_USER_SETTINGS);
  });

  it('round-trips and keeps fields it does not know', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-settings-'));
    try {
      await fsp.writeFile(path.join(dir, 'huddle-settings.json'), JSON.stringify({ theme: 'dark' }));
      const read = await readHuddleSettings(dir);
      expect(read).toEqual({
        consentedAt: null,
        consentedFor: null,
        consentedFingerprint: null,
        extra: { theme: 'dark' },
      });
      await writeHuddleSettings(dir, {
        ...read,
        consentedAt: '2026-11-13T10:00:00.000Z',
        consentedFor: 'C:/cfg/settings.json',
        consentedFingerprint: FP,
      });
      expect(JSON.parse(await fsp.readFile(path.join(dir, 'huddle-settings.json'), 'utf8'))).toEqual({
        theme: 'dark',
        consentedAt: '2026-11-13T10:00:00.000Z',
        consentedFor: 'C:/cfg/settings.json',
        consentedFingerprint: FP,
      });
      expect((await readHuddleSettings(dir)).consentedFingerprint).toBe(FP);
      expect((await fsp.readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
