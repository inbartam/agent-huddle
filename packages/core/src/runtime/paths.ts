/**
 * One checker for folder paths that come from a template, the renderer or the event log (security review L3).
 *
 * A path the Huddle stats, spawns in or opens must be a plain local absolute path. On Windows a UNC path
 * (`\\host\share`, `//host/share`) makes the OS connect to that host and offer the user's credentials as soon as it is
 * stat-ed, and the device forms (`\\?\`, `\\.\`, the NT form `\??\`) skip Win32 path normalization or reach devices
 * and pipes. So the check is purely textual and runs **before** any file system call. Pure.
 */
import path from 'node:path';
import { CLIP_LIMITS } from '@huddle/shared';

// eslint-disable-next-line no-control-regex -- NUL and control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f]/;
/** `\\host`, `//host`, `\\?\`, `\\.\` and mixed-slash forms: two leading separators. */
const DOUBLE_LEADING_SEPARATOR = /^[\\/]{2}/;
/** The NT object-manager prefix `\??\` (also `/??/`), which reaches `\??\UNC\host\…` and devices. */
const NT_PREFIX = /^[\\/]\?\?[\\/]/;
/** A drive-absolute Windows path: `C:\` or `C:/`. Not `C:relative` (drive-relative) and not `\rooted` (current drive). */
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Is `p` a plain, local, absolute path? Refuses non-strings, empty and overlong strings (over CLIP_LIMITS.path), NUL
 * and other control characters, any two leading separators (UNC, `\\?\`, `\\.\`), `\??\`, and anything that is not
 * absolute. On Windows it must also start with a drive (`C:\`), and a `:` after the drive (an alternate data stream)
 * is refused. Pure; no file system access.
 */
export function isLocalAbsolutePath(p: unknown, platform: NodeJS.Platform = process.platform): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > CLIP_LIMITS.path) return false;
  if (CONTROL.test(p) || DOUBLE_LEADING_SEPARATOR.test(p) || NT_PREFIX.test(p)) return false;
  if (platform === 'win32') {
    if (!DRIVE_ABSOLUTE.test(p) || p.indexOf(':', 2) !== -1) return false;
    return path.win32.isAbsolute(p);
  }
  return path.posix.isAbsolute(p);
}
