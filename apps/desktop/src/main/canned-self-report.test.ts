/** The canned dev core's Self-reported progress answers (F27): in memory only, expired on an old fingerprint. */
import { describe, expect, it } from 'vitest';
import { createCannedSelfReport } from './canned-self-report.js';

describe('Self-reported progress: the canned dev core', () => {
  it('registers and removes in memory, refuses an old fingerprint as expired', () => {
    const c = createCannedSelfReport();
    const reg = c.preview('register');
    expect(reg).toMatchObject({ state: 'absent', changed: true, refusal: null });
    expect(reg.commands[0]).toContain('claude mcp add --scope user huddle');
    expect(c.command({ type: 'setup.selfReport.register', fingerprint: reg.fingerprint })).toEqual({ ok: true });
    expect(c.preview('register')).toMatchObject({ state: 'ours', changed: false, commands: [] });
    expect(c.command({ type: 'setup.selfReport.register', fingerprint: reg.fingerprint })).toMatchObject({
      ok: false,
      code: 'expired',
    });
    const rm = c.preview('unregister');
    expect(c.command({ type: 'setup.selfReport.unregister', fingerprint: rm.fingerprint })).toEqual({ ok: true });
    expect(c.preview('register').state).toBe('absent');
    expect(c.command({ type: 'all.pause' })).toBeNull();
  });
});
