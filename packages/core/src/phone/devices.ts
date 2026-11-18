/**
 * Paired phones (M6, F26): `<dataDir>/phone-devices.json`. Per device: a random id, the name the phone gave, when it
 * was paired and last seen, and the sha-256 of its token. Never the token itself: a copied file cannot be used to act
 * as a phone. Written atomically (temp file + rename) and owner-only (`writeTextAtomic`). Read field by field: a bad
 * entry is dropped, never an exception.
 *
 * Tokens: 32 random bytes, base64url (256 bits). Lookup compares the sha-256 of the presented token with every
 * stored hash in constant time, and goes through all of them, so timing tells nothing about which device matched.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PHONE_DEVICE_NAME_MAX, PHONE_MAX_DEVICES } from '@huddle/shared';
import { writeTextAtomic } from '../runtime/atomic-file.js';

export const PHONE_DEVICES_FILENAME = 'phone-devices.json';

export interface StoredPhoneDevice {
  deviceId: string;
  name: string;
  /** sha-256 of the token, lower-case hex. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number | null;
}

const DEVICE_ID = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
/** A presented token: base64url, 43 characters for 32 bytes. Anything else is refused before hashing. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const deviceSchema = z.looseObject({
  deviceId: z.string().regex(DEVICE_ID),
  name: z.string().max(PHONE_DEVICE_NAME_MAX * 4),
  tokenHash: z.string().regex(HASH),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
});

export function phoneDevicesPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), PHONE_DEVICES_FILENAME);
}

/** A device name as stored and shown: control characters out, whitespace collapsed, clipped. Empty: "Phone". */
export function cleanDeviceName(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // C0, DEL, C1, and the bidi / zero-width controls that can make a name look like another.
    const control =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    out += control ? ' ' : ch;
  }
  const trimmed = out.replace(/\s+/g, ' ').trim();
  const clipped = Array.from(trimmed).slice(0, PHONE_DEVICE_NAME_MAX).join('').trim();
  return clipped === '' ? 'Phone' : clipped;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newDeviceId(): string {
  return randomBytes(16).toString('hex');
}

/** Pure: file text to devices. Unreadable: none (and `bad`, so the caller does not overwrite it blindly). */
export function parsePhoneDevices(text: string | null): { devices: StoredPhoneDevice[]; bad: boolean } {
  if (text === null) return { devices: [], bad: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { devices: [], bad: true };
  }
  const list: unknown =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).devices : null;
  if (!Array.isArray(list)) return { devices: [], bad: true };
  const devices: StoredPhoneDevice[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const parsed = deviceSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.deviceId)) continue;
    seen.add(parsed.data.deviceId);
    devices.push({
      deviceId: parsed.data.deviceId,
      name: cleanDeviceName(parsed.data.name),
      tokenHash: parsed.data.tokenHash,
      createdAt: parsed.data.createdAt,
      lastSeenAt: parsed.data.lastSeenAt,
    });
    if (devices.length >= PHONE_MAX_DEVICES) break;
  }
  return { devices, bad: false };
}

export function serializePhoneDevices(devices: readonly StoredPhoneDevice[]): string {
  return `${JSON.stringify(
    {
      version: 1,
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        tokenHash: d.tokenHash,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
      })),
    },
    null,
    2,
  )}\n`;
}

export async function readPhoneDevices(dataDir: string): Promise<{ devices: StoredPhoneDevice[]; bad: boolean }> {
  let text: string | null;
  try {
    text = await fsp.readFile(phoneDevicesPath(dataDir), 'utf8');
  } catch {
    text = null;
  }
  return parsePhoneDevices(text);
}

export async function writePhoneDevices(dataDir: string, devices: readonly StoredPhoneDevice[]): Promise<void> {
  await writeTextAtomic(phoneDevicesPath(dataDir), serializePhoneDevices(devices));
}

/** Removes the file (delete all history with no phone left). Missing is fine. */
export async function removePhoneDevicesFile(dataDir: string): Promise<void> {
  await fsp.rm(phoneDevicesPath(dataDir), { force: true });
}

/**
 * The device this token belongs to, or null. Malformed tokens are refused before hashing; every stored hash is
 * compared (constant time each), so the time taken does not depend on which one matched.
 */
export function deviceForToken(devices: readonly StoredPhoneDevice[], token: string): StoredPhoneDevice | null {
  if (!TOKEN.test(token)) return null;
  const presented = Buffer.from(hashToken(token), 'hex');
  let found: StoredPhoneDevice | null = null;
  for (const device of devices) {
    const stored = Buffer.from(device.tokenHash, 'hex');
    if (stored.length === presented.length && timingSafeEqual(stored, presented) && found === null) found = device;
  }
  return found;
}
