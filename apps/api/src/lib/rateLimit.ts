import { rateLimits } from '../db.js';
import { TooManyRequestsError } from '../errors.js';

export interface RateLimiterOptions {
  /**
   * Which limiter this is. Every limiter shares one collection, so this is what
   * keeps the sign-in quota and the registration quota from being the same
   * bucket for the same address.
   */
  name: string;
  limit: number;
  windowMs: number;
  message?: string;
  /**
   * Off in the test suite, where every request shares one IP and the limiter
   * would throttle the tests rather than an attacker. The limiter has its own
   * unit tests, so switching it off here does not leave it unverified.
   *
   * Off also means "touch the database not at all", which is what lets a route
   * test run without the collection existing.
   */
  enabled?: boolean;
}

export type RateLimiter = (key: string) => Promise<void>;

/**
 * Fixed-window limiter whose buckets live in Mongo, so the quota is the
 * instance's quota rather than each process's.
 *
 * Windows are aligned to the clock rather than anchored to a key's first
 * request: `windowStart` is derivable from the time alone, so two instances
 * agree on which bucket a request belongs to without coordinating. Counting is
 * then one upsert with `$inc` — atomic in the database, so two instances racing
 * on the same key cannot both read "9 of 10" and both allow.
 *
 * Fixed windows admit the usual burst across a boundary: a client can spend a
 * full quota at the end of one window and another at the start of the next. That
 * was true of the in-memory version too, and for "how many sign-ins may one
 * address attempt" it is the intended trade for keeping the state one document
 * and one write.
 *
 * Nothing here fails open. If Mongo is unreachable the error propagates, which
 * matters less than it sounds: the routes behind this limiter read users and
 * write sessions, so a request that cannot reach Mongo was going to fail anyway.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const enabled = options.enabled ?? true;

  return async function consume(key: string): Promise<void> {
    if (!enabled) return;

    const windowStart = Math.floor(Date.now() / options.windowMs) * options.windowMs;
    const bucket = await rateLimits().findOneAndUpdate(
      { _id: `${options.name}:${windowStart}:${key}` },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date(windowStart + options.windowMs) },
      },
      { upsert: true, returnDocument: 'after' },
    );

    // Upserted, so there is always a document; the null branch is the driver's
    // type, not a case that happens.
    if ((bucket?.count ?? 1) > options.limit) throw new TooManyRequestsError(options.message);
  };
}
