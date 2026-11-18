import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PHONE_MAX_DEVICES } from '@huddle/shared';
import {
  cleanDeviceName,
  deviceForToken,
  hashToken,
  newDeviceId,
  newDeviceToken,
  parsePhoneDevices,
  phoneDevicesPath,
  readPhoneDevices,
  writePhoneDevices,
  type StoredPhoneDevice,
} from './devices.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});

function device(token: string, extra: Partial<StoredPhoneDevice> = {}): StoredPhoneDevice {
  return {
    deviceId: newDeviceId(),
    name: 'Pixel',
    tokenHash: hashToken(token),
    createdAt: 1,
    lastSeenAt: null,
    ...extra,
  };
}

describe('phone devices', () => {
  it('makes 256-bit base64url tokens and 128-bit hex ids', () => {
    const token = newDeviceToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(newDeviceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newDeviceToken()).not.toBe(token);
  });

  it('finds a device by its token and refuses wrong or malformed ones', () => {
    const a = newDeviceToken();
    const b = newDeviceToken();
    const list = [device(a), device(b)];
    expect(deviceForToken(list, b)?.deviceId).toBe(list[1]?.deviceId);
    expect(deviceForToken(list, newDeviceToken())).toBeNull();
    expect(deviceForToken(list, 'short')).toBeNull();
    expect(deviceForToken(list, list[0]?.tokenHash ?? '')).toBeNull();
  });

  it('stores only the hash, atomically and owner-only, and reads it back', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huddle-phone-'));
    dirs.push(dir);
    const token = newDeviceToken();
    const d = device(token, { lastSeenAt: 5 });
    await writePhoneDevices(dir, [d]);
    const text = await fsp.readFile(phoneDevicesPath(dir), 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain(d.tokenHash);
    expect(await readPhoneDevices(dir)).toEqual({ devices: [d], bad: false });
    if (process.platform !== 'win32') {
      expect((await fsp.stat(phoneDevicesPath(dir))).mode & 0o077).toBe(0);
    }
    const left = (await fsp.readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(left).toEqual([]);
  });

  it('drops bad entries, duplicates and anything past the limit; unreadable is bad, missing is not', () => {
    const good = device(newDeviceToken());
    const many = Array.from({ length: PHONE_MAX_DEVICES + 3 }, () => device(newDeviceToken()));
    const text = JSON.stringify({
      devices: [good, good, { deviceId: 'x' }, { ...good, deviceId: newDeviceId(), tokenHash: 'zz' }, ...many],
    });
    const parsed = parsePhoneDevices(text);
    expect(parsed.bad).toBe(false);
    expect(parsed.devices).toHaveLength(PHONE_MAX_DEVICES);
    expect(parsed.devices[0]).toEqual(good);
    expect(parsePhoneDevices('{not json')).toEqual({ devices: [], bad: true });
    expect(parsePhoneDevices(null)).toEqual({ devices: [], bad: false });
  });

  it('cleans device names: controls and bidi marks out, whitespace collapsed, clipped, never empty', () => {
    expect(cleanDeviceName('  My‮iPhone\n\t 15 ')).toBe('My iPhone 15');
    expect(cleanDeviceName('\u0000​')).toBe('Phone');
    expect(Array.from(cleanDeviceName('x'.repeat(500)))).toHaveLength(60);
  });
});
