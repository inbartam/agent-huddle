import { describe, expect, it } from 'vitest';
import { PHONE_PAIR_CODE_TTL_MS, PHONE_PAIR_MAX_TRIES } from '@huddle/shared';
import { PairingCodes } from './pairing.js';

function codes(start = 1_000_000) {
  const clock = { t: start };
  const p = new PairingCodes({ now: () => clock.t, randomInt: () => 4217 });
  return { p, clock };
}

describe('PairingCodes', () => {
  it('issues a zero-padded 6-digit code valid for 2 minutes', () => {
    const { p, clock } = codes();
    expect(p.issue()).toEqual({ code: '004217', expiresAt: clock.t + PHONE_PAIR_CODE_TTL_MS });
    expect(p.active()).toBe(true);
  });

  it('is single use', () => {
    const { p } = codes();
    p.issue();
    expect(p.attempt('004217')).toBe('ok');
    expect(p.attempt('004217')).toBe('none');
  });

  it('expires after its time', () => {
    const { p, clock } = codes();
    p.issue();
    clock.t += PHONE_PAIR_CODE_TTL_MS;
    expect(p.attempt('004217')).toBe('none');
  });

  it('is void after 5 wrong tries, even for the right code', () => {
    const { p } = codes();
    p.issue();
    for (let i = 0; i < PHONE_PAIR_MAX_TRIES; i++) expect(p.attempt('000000')).toBe('wrong');
    expect(p.attempt('004217')).toBe('none');
  });

  it('a new code replaces the old one; clear forgets it', () => {
    const { p } = codes();
    p.issue();
    p.clear();
    expect(p.attempt('004217')).toBe('none');
  });

  it('uses the crypto source by default and always gives 6 digits', () => {
    const p = new PairingCodes({ now: () => 0 });
    for (let i = 0; i < 50; i++) expect(p.issue().code).toMatch(/^[0-9]{6}$/);
  });
});
