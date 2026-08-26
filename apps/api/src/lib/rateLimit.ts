import { TooManyRequestsError } from '../errors.js';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window limiter, scoped to a single process.
 *
 * Good enough while invintelx.org runs one API instance. The moment it runs
 * two, this needs to move to Mongo or Redis - two processes each allowing the
 * full quota is twice the intended limit.
 */
export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  message?: string;
  /**
   * Off in the test suite, where every request shares one IP and the limiter
   * would throttle the tests rather than an attacker. The limiter has its own
   * unit tests, so switching it off here does not leave it unverified.
   */
  enabled?: boolean;
}) {
  const buckets = new Map<string, Bucket>();
  const enabled = options.enabled ?? true;

  return function consume(key: string): void {
    if (!enabled) return;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      // Opportunistic sweep so the map cannot grow without bound.
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      }
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.limit) throw new TooManyRequestsError(options.message);
  };
}
