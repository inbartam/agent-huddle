// Writes the tray/app icon as a multi-size Windows .ico (16 to 64 px; tray and window sizes at 100-200% scaling).
// No dependencies: each size is an uncompressed 32-bit BGRA DIB, drawn with 4x4 supersampling.
// The motif: three agents in a huddle (one above, two below) on a dark rounded square.
// Usage: node scripts/make-icon.mjs <out.ico> [--app]
//   --app: the installer and exe icon (P6, electron-builder.json win.icon), which needs a 256 px image.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SIZES = [16, 20, 24, 32, 40, 48, 64];
/** The exe, Start menu and installer icon (electron-builder wants 256 px). Uncompressed like the tray sizes. */
export const APP_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG = [0x1b, 0x23, 0x30]; // slate
const FG = [[0x5e, 0xea, 0xd4], [0x93, 0xc5, 0xfd], [0x93, 0xc5, 0xfd]]; // teal lead, blue members

/** Coverage-weighted colour of one pixel in a unit square scene. Returns [r,g,b,a] 0..255. */
function sample(x, y) {
  // rounded square, radius 0.22
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  const dots = [
    [0.5, 0.33, 0.15],
    [0.3, 0.67, 0.13],
    [0.7, 0.67, 0.13],
  ];
  for (let i = 0; i < dots.length; i++) {
    const [dx, dy, dr] = dots[i];
    if ((x - dx) ** 2 + (y - dy) ** 2 <= dr * dr) return FG[i];
  }
  return BG;
}

function render(size) {
  const ss = 4;
  const px = new Uint8Array(size * size * 4); // RGBA, top-down
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample((pxi + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const o = (py * size + pxi) * 4;
      if (a > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
      }
      px[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return px;
}

/** BITMAPINFOHEADER + bottom-up BGRA rows + 1-bpp AND mask (all zero: alpha decides). */
function dib(size) {
  const rgba = render(size);
  const maskRow = Math.ceil(size / 32) * 4;
  const buf = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  buf.writeUInt32LE(40, 0); // biSize
  buf.writeInt32LE(size, 4); // width
  buf.writeInt32LE(size * 2, 8); // height: XOR + AND
  buf.writeUInt16LE(1, 12); // planes
  buf.writeUInt16LE(32, 14); // bpp
  buf.writeUInt32LE(0, 16); // BI_RGB
  buf.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  let o = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[o++] = rgba[i + 2];
      buf[o++] = rgba[i + 1];
      buf[o++] = rgba[i];
      buf[o++] = rgba[i + 3];
    }
  }
  return buf;
}

export function buildIco(sizes = SIZES) {
  const images = sizes.map(dib);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(s >= 256 ? 0 : s, e); // 0 means 256
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2); // palette
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bpp
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

const isCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
const out = process.argv[2];
if (isCli && out) {
  const path = resolve(out);
  writeFileSync(path, buildIco(process.argv.includes('--app') ? APP_ICON_SIZES : SIZES));
  console.log(`wrote ${path}`);
}
