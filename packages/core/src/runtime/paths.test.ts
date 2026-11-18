import { describe, expect, it } from 'vitest';
import { CLIP_LIMITS } from '@huddle/shared';
import { isLocalAbsolutePath } from './paths.js';

describe('isLocalAbsolutePath (security review L3)', () => {
  it('accepts a drive-absolute Windows path, either slash', () => {
    for (const p of ['C:\\projects\\x', 'c:/projects/x', 'D:\\', 'C:\\Users\\A User\\repo']) {
      expect(isLocalAbsolutePath(p, 'win32'), p).toBe(true);
    }
  });

  it('refuses UNC and device forms on Windows, with either slash', () => {
    for (const p of [
      '\\\\host\\share',
      '//host/share',
      '\\/host/share',
      '\\\\?\\C:\\x',
      '\\\\?\\UNC\\host\\share',
      '\\\\.\\C:\\x',
      '\\\\.\\pipe\\name',
      '//?/C:/x',
      '//./pipe/name',
      '\\??\\UNC\\host\\share',
      '\\??\\C:\\x',
      '/??/C:/x',
    ]) {
      expect(isLocalAbsolutePath(p, 'win32'), p).toBe(false);
    }
  });

  it('refuses relative, drive-relative and rooted-without-drive paths on Windows', () => {
    for (const p of ['relative\\x', '.', '..\\x', 'C:relative', 'C:', '\\rooted\\no-drive', '/rooted/no-drive']) {
      expect(isLocalAbsolutePath(p, 'win32'), p).toBe(false);
    }
  });

  it('refuses a colon after the drive (alternate data streams) on Windows', () => {
    expect(isLocalAbsolutePath('C:\\x\\y:stream', 'win32')).toBe(false);
    expect(isLocalAbsolutePath('C:\\x::$INDEX_ALLOCATION', 'win32')).toBe(false);
  });

  it('refuses NUL and other control characters, empty, overlong and non-strings', () => {
    expect(isLocalAbsolutePath('C:\\x\u0000y', 'win32')).toBe(false);
    expect(isLocalAbsolutePath('C:\\x\ny', 'win32')).toBe(false);
    expect(isLocalAbsolutePath('C:\\x\u007fy', 'win32')).toBe(false);
    expect(isLocalAbsolutePath('/x\u0000y', 'linux')).toBe(false);
    expect(isLocalAbsolutePath('', 'win32')).toBe(false);
    expect(isLocalAbsolutePath(`C:\\${'a'.repeat(CLIP_LIMITS.path)}`, 'win32')).toBe(false);
    expect(isLocalAbsolutePath(42, 'win32')).toBe(false);
    expect(isLocalAbsolutePath(null, 'linux')).toBe(false);
  });

  it('on POSIX: absolute only, and never a leading double slash', () => {
    expect(isLocalAbsolutePath('/home/a/repo', 'linux')).toBe(true);
    expect(isLocalAbsolutePath('/Users/a/repo', 'darwin')).toBe(true);
    expect(isLocalAbsolutePath('relative/x', 'linux')).toBe(false);
    expect(isLocalAbsolutePath('//host/share', 'linux')).toBe(false);
    expect(isLocalAbsolutePath('C:\\x', 'linux')).toBe(false);
  });
});
