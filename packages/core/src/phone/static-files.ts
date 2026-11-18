/**
 * The phone page's files (M6, F26; the page is built from apps/desktop/src/phone to out/phone). Served from one folder passed in, and only from it:
 *  - the URL path must be plain: `/` or segments of letters, digits, `.`, `_`, `-` (no `..`, no dot files, no
 *    backslash, no percent-encoding, no drive letters), at most 4 deep;
 *  - only known extensions, each with its content type; anything else is 404;
 *  - the resolved file must still be inside the folder, must be a regular file (never a link: `lstat`, and the folder's
 *    real path is compared too), and at most MAX_STATIC_BYTES.
 * The page holds no data, so it needs no token; the API does.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const MAX_STATIC_BYTES = 2 * 1024 * 1024;

export const STATIC_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
/** Windows device names (`NUL.html` opens the device, not a file). */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/** Pure: the URL path to relative segments, or null when it is not a plain path we serve. `/` is `index.html`. */
export function staticSegments(urlPath: string): string[] | null {
  if (urlPath === '/' || urlPath === '') return ['index.html'];
  if (!urlPath.startsWith('/') || urlPath.length > 300) return null;
  const parts = urlPath.slice(1).split('/');
  if (parts.length > 4) return null;
  for (const part of parts) {
    if (!SEGMENT.test(part) || part.includes('..') || WINDOWS_DEVICE.test(part) || part.endsWith('.')) return null;
  }
  const ext = path.extname(parts[parts.length - 1] ?? '').toLowerCase();
  if (!Object.hasOwn(STATIC_TYPES, ext)) return null;
  return parts;
}

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

/** Reads one file of the page, or null (not found, not allowed, too big, a link, outside the folder). Never throws. */
export async function readStaticFile(root: string, urlPath: string): Promise<StaticFile | null> {
  const parts = staticSegments(urlPath);
  if (parts === null) return null;
  try {
    const base = await fsp.realpath(path.resolve(root));
    const target = path.resolve(base, ...parts);
    const rel = path.relative(base, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    // No link anywhere on the way: every folder between base and the file, and the file itself.
    let walk = base;
    for (const part of parts) {
      walk = path.join(walk, part);
      const st = await fsp.lstat(walk);
      if (st.isSymbolicLink()) return null;
    }
    const st = await fsp.lstat(target);
    if (!st.isFile() || st.size > MAX_STATIC_BYTES) return null;
    const body = await fsp.readFile(target);
    if (body.length > MAX_STATIC_BYTES) return null;
    const ext = path.extname(target).toLowerCase();
    const contentType = STATIC_TYPES[ext];
    return contentType === undefined ? null : { body, contentType };
  } catch {
    return null;
  }
}
