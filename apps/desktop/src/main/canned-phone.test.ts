/**
 * The canned dev core (HUDDLE_DEV_CANNED=1) and phone access (M6, F26): sample data has no listener, so every phone
 * command and the address query answer `unsupported` with one sentence the Settings section shows, and nothing changes.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_SETTINGS, type HuddleCommand } from '@huddle/shared';
import { CANNED_PHONE_WORDS, createCannedCore } from './canned-core.js';
import { createMemorySettingsHost } from './settings-host.js';

describe('canned core, phone access', () => {
  it('refuses phone commands and phone.addresses in words, and the state stays without phone', async () => {
    const host = createMemorySettingsHost(createCannedCore(), DEFAULT_USER_SETTINGS);
    const cmds: HuddleCommand[] = [
      { type: 'phone.enable', ip: '192.168.1.20', port: 47835 },
      { type: 'phone.disable' },
      { type: 'phone.pair' },
      { type: 'phone.revoke', deviceId: 'all' },
    ];
    for (const cmd of cmds) {
      expect(await host.command(cmd)).toEqual({ ok: false, code: 'unsupported', message: CANNED_PHONE_WORDS });
    }
    expect(await host.query({ type: 'phone.addresses' })).toEqual({
      ok: false,
      code: 'unsupported',
      message: CANNED_PHONE_WORDS,
    });
    expect(host.getState().phone).toBeUndefined();
    await host.dispose();
  });
});
