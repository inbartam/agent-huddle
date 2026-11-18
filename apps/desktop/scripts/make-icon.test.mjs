import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_ICON_SIZES, buildIco } from './make-icon.mjs';

function entries(buf) {
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + 16 * i;
    return { size: buf.readUInt8(e) || 256, bpp: buf.readUInt16LE(e + 6), bytes: buf.readUInt32LE(e + 8), offset: buf.readUInt32LE(e + 12) };
  });
}

describe('tray .ico', () => {
  it('is a valid multi-size icon directory with 32-bit images that fit the file', () => {
    const buf = buildIco();
    expect(buf.readUInt16LE(0)).toBe(0);
    expect(buf.readUInt16LE(2)).toBe(1);
    const list = entries(buf);
    expect(list.map((e) => e.size)).toEqual([16, 20, 24, 32, 40, 48, 64]);
    for (const e of list) {
      expect(e.bpp).toBe(32);
      expect(e.offset + e.bytes).toBeLessThanOrEqual(buf.length);
      expect(buf.readUInt32LE(e.offset)).toBe(40); // BITMAPINFOHEADER
      expect(buf.readInt32LE(e.offset + 8)).toBe(e.size * 2);
    }
  });

  it('matches the committed resources/tray.ico (regenerate with `npm run icon`)', () => {
    const committed = readFileSync(new URL('../resources/tray.ico', import.meta.url));
    expect(committed.equals(buildIco())).toBe(true);
  });

  it('matches the committed resources/icon.ico, with the 256 px image the installer needs (`npm run icon:app`)', () => {
    const committed = readFileSync(new URL('../resources/icon.ico', import.meta.url));
    expect(committed.equals(buildIco(APP_ICON_SIZES))).toBe(true);
    expect(entries(committed).map((e) => e.size)).toContain(256);
  });
});
