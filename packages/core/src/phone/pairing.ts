/**
 * Pairing codes (M6, F26): one 6-digit code at a time, shown on the desktop, single use, valid
 * PHONE_PAIR_CODE_TTL_MS, invalid after PHONE_PAIR_MAX_TRIES wrong tries. Kept in memory only: never written to disk
 * or into an event. The clock and the random source are injected.
 *
 * The compare is constant-time over digests, so timing says nothing about how many digits were right.
 */
import { createHash, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import {
  PHONE_PAIR_CODE_DIGITS,
  PHONE_PAIR_CODE_TTL_MS,
  PHONE_PAIR_MAX_TRIES,
  type PhonePairing,
} from '@huddle/shared';

export type PairAttempt =
  /** Right code: it is used up. */
  | 'ok'
  /** No code in force (none issued, used, expired, or locked out). */
  | 'none'
  /** Wrong code; `left` tries remain (0: the code is now invalid). */
  | 'wrong';

export interface PairingOptions {
  now: () => number;
  /** A uniform integer in [0, max). Defaults to `crypto.randomInt`. */
  randomInt?: (max: number) => number;
  ttlMs?: number;
  maxTries?: number;
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

export class PairingCodes {
  private readonly now: () => number;
  private readonly randomInt: (max: number) => number;
  private readonly ttlMs: number;
  private readonly maxTries: number;
  private current: { digest: Buffer; expiresAt: number; wrong: number } | null = null;

  constructor(options: PairingOptions) {
    this.now = options.now;
    this.randomInt = options.randomInt ?? ((max) => cryptoRandomInt(max));
    this.ttlMs = options.ttlMs ?? PHONE_PAIR_CODE_TTL_MS;
    this.maxTries = options.maxTries ?? PHONE_PAIR_MAX_TRIES;
  }

  /** A new code; the one in force (if any) stops working. */
  issue(): PhonePairing {
    const max = 10 ** PHONE_PAIR_CODE_DIGITS;
    const code = String(this.randomInt(max)).padStart(PHONE_PAIR_CODE_DIGITS, '0');
    const expiresAt = this.now() + this.ttlMs;
    this.current = { digest: digest(code), expiresAt, wrong: 0 };
    return { code, expiresAt };
  }

  /** A code is in force right now. */
  active(): boolean {
    const c = this.current;
    if (c === null) return false;
    if (this.now() >= c.expiresAt) {
      this.current = null;
      return false;
    }
    return true;
  }

  /** Try a code. The right one is used up; the last wrong try voids the code. */
  attempt(code: string): PairAttempt {
    if (!this.active()) return 'none';
    const c = this.current;
    if (c === null) return 'none';
    if (timingSafeEqual(digest(code), c.digest)) {
      this.current = null;
      return 'ok';
    }
    c.wrong += 1;
    if (c.wrong >= this.maxTries) this.current = null;
    return 'wrong';
  }

  /** Forget the code in force (phone access turned off). */
  clear(): void {
    this.current = null;
  }
}
