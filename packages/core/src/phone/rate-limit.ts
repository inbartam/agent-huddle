/**
 * Per-address token buckets for the phone listener (M6, F26). Pure bookkeeping over an injected clock.
 *
 * A bucket holds up to `capacity` tokens and gains `refillPerSec` per second; a request takes one, and is refused
 * (429) when none is left. Addresses not seen for a while are forgotten, and at most `maxKeys` are kept, so a scan
 * from many addresses cannot grow the table without bound.
 */
export interface BucketSpec {
  capacity: number;
  refillPerSec: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly spec: BucketSpec;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(spec: BucketSpec, now: () => number, maxKeys = 1024) {
    this.spec = spec;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  private bucket(key: string): Bucket {
    const now = this.now();
    let b = this.buckets.get(key);
    if (b === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next();
        if (oldest.done !== true) this.buckets.delete(oldest.value);
      }
      b = { tokens: this.spec.capacity, at: now };
      this.buckets.set(key, b);
      return b;
    }
    const gained = (Math.max(0, now - b.at) / 1000) * this.spec.refillPerSec;
    b.tokens = Math.min(this.spec.capacity, b.tokens + gained);
    b.at = now;
    // Most recently used last, so eviction takes the stalest.
    this.buckets.delete(key);
    this.buckets.set(key, b);
    return b;
  }

  /** Takes one token; false when none is left (the request is refused). */
  take(key: string): boolean {
    const b = this.bucket(key);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** True when the key has no token left right now (does not take one). */
  empty(key: string): boolean {
    return this.bucket(key).tokens < 1;
  }

  clear(): void {
    this.buckets.clear();
  }
}
