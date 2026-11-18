import { describe, expect, it } from 'vitest';
import { isM6Command, isM6Query, parseM6Command, parseM6Query } from './m6-schemas.js';

describe('M6 contracts', () => {
  it('accepts the phone commands in their shapes', () => {
    expect(parseM6Command({ type: 'phone.enable', ip: '192.168.1.23' })).toEqual({
      type: 'phone.enable',
      ip: '192.168.1.23',
    });
    expect(parseM6Command({ type: 'phone.enable', ip: '10.0.0.2', port: 47835 })).toMatchObject({ port: 47835 });
    expect(parseM6Command({ type: 'phone.disable' })).toEqual({ type: 'phone.disable' });
    expect(parseM6Command({ type: 'phone.pair' })).toEqual({ type: 'phone.pair' });
    expect(parseM6Command({ type: 'phone.revoke', deviceId: 'all' })).toEqual({
      type: 'phone.revoke',
      deviceId: 'all',
    });
    expect(parseM6Command({ type: 'phone.revoke', deviceId: 'a'.repeat(32) })).not.toBeNull();
  });

  it('refuses malformed ones and never throws', () => {
    for (const bad of [
      { type: 'phone.enable' },
      { type: 'phone.enable', ip: 'localhost' },
      { type: 'phone.enable', ip: '192.168.1.023' },
      { type: 'phone.enable', ip: '192.168.1.2', port: 80 },
      { type: 'phone.enable', ip: '192.168.1.2', port: 70000 },
      { type: 'phone.enable', ip: '192.168.1.2', port: 1.5 },
      { type: 'phone.revoke' },
      { type: 'phone.revoke', deviceId: 'ALL' },
      { type: 'phone.revoke', deviceId: '../x' },
      { type: 'phone.message', text: 'hi' },
      null,
      'phone.pair',
    ]) {
      expect(parseM6Command(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('self-report registration (F27): fingerprint is 64 hex, the preview takes a mode', () => {
    const fp = 'a'.repeat(64);
    expect(parseM6Command({ type: 'setup.selfReport.register', fingerprint: fp })).toEqual({
      type: 'setup.selfReport.register',
      fingerprint: fp,
    });
    expect(parseM6Command({ type: 'setup.selfReport.unregister', fingerprint: fp })).not.toBeNull();
    for (const bad of [
      { type: 'setup.selfReport.register' },
      { type: 'setup.selfReport.register', fingerprint: 'A'.repeat(64) },
      { type: 'setup.selfReport.register', fingerprint: 'a'.repeat(63) },
    ]) {
      expect(parseM6Command(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(isM6Command({ type: 'setup.selfReport.unregister' })).toBe(true);
    expect(parseM6Query({ type: 'setup.selfReportPreview', mode: 'register' })).toEqual({
      type: 'setup.selfReportPreview',
      mode: 'register',
    });
    expect(parseM6Query({ type: 'setup.selfReportPreview', mode: 'both' })).toBeNull();
    expect(parseM6Query({ type: 'setup.selfReportPreview' })).toBeNull();
  });

  it('knows its own types', () => {
    expect(isM6Command({ type: 'phone.pair' })).toBe(true);
    expect(isM6Command({ type: 'approval.decide' })).toBe(false);
    expect(isM6Query({ type: 'phone.addresses' })).toBe(true);
    expect(parseM6Query({ type: 'phone.addresses' })).toEqual({ type: 'phone.addresses' });
    expect(parseM6Query({ type: 'history.list' })).toBeNull();
  });
});
