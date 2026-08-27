import { rateLimits } from '../db.js';
import { TooManyRequestsError } from '../errors.js';

/**
 * How long one bucket write may take before the request gives up.
 *
 * `connect()` sets `serverSelectionTimeoutMS`, which covers "no reachable
 * server". It does not cover a primary that accepted the connection and then
 * stalled, and this call now sits in front of the unauthenticated sign-in path:
 * without a deadline, a stalled primary turns every login into a held socket,
 * which is a cheaper denial of service than the one the limiter exists to
 * prevent.
 */
const OPERATION_TIMEOUT_MS = 2000;

/**
 * Distinct keys one process will open a bucket for within one window.
 *
 * 10000, which is the bound the in-memory limiter carried, for the same reason
 * it carried it: the key is client-supplied, so without a cap the caller
 * chooses how much storage exists. See `maxKeys` below for what changed about
 * the cost of getting that wrong.
 */
const DEFAULT_MAX_KEYS = 10_000;

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
   * Ceiling on how many distinct keys this process opens a bucket for in one
   * window. Past it, a key this process has not seen this window is refused
   * without a database write.
   *
   * The bound matters more here than it did in memory. A key is an address the
   * client can influence — `app.ts` sets `trust proxy` to 1, so `req.ip` is
   * whatever the hop in front reported, and a production deployment with no
   * reverse proxy in front of it (README documents that as a supported
   * topology) makes that the caller's own `X-Forwarded-For` header. Unbounded,
   * one client varying one header per request used to grow a Map; now it would
   * be one durable upsert per forged address into the primary datastore, held
   * for a full window. The doubling this limiter was moved to Mongo to fix is a
   * factor of two. That would be unbounded.
   *
   * The cap is per process, not per deployment, so the ceiling on documents is
   * instances × maxKeys rather than maxKeys. That is deliberate. A single
   * shared counter document would give the tighter bound but would not bound
   * the thing that actually hurts — it costs a second write on every new key,
   * and refusing after the fact means deleting the bucket that was already
   * written, so an attacker past the ceiling drives *more* writes than before,
   * not none. Counting admissions in the process refuses before the round trip,
   * which caps storage at a small multiple and caps the write rate outright.
   *
   * What it costs: a window that has admitted its full complement of keys
   * refuses addresses it has not seen until the window rolls over. Addresses
   * already admitted keep working. At 10000 distinct addresses attempting
   * sign-in inside one window this instance is being scanned rather than used,
   * and refusing is the right answer for a credential-guessing control — but it
   * is a refusal of real clients too, so it is a real trade and not a free one.
   */
  maxKeys?: number;
  /**
   * Off in the test suite, where every request shares one IP and the limiter
   * would throttle the tests rather than an attacker. The limiter has its own
   * unit tests, so switching it off here does not leave it unverified.
   *
   * Off also means "touch the database not at all", which is what lets a route
   * test run without the collection existing.
   */
  enabled?: boolean;
  /**
   * The clock, injectable so that a test about window rollover can be
   * arithmetic instead of a real wait. Fake timers are not an option: the
   * driver's heartbeats and timeouts run on the same clock, so freezing it
   * freezes Mongo too.
   */
  now?: () => number;
}

export type RateLimiter = (key: string) => Promise<void>;

/**
 * Fixed-window limiter whose buckets live in Mongo, so the quota is the
 * deployment's rather than each process's.
 *
 * Windows are aligned to the clock rather than anchored to a key's first
 * request: `windowStart` is derivable from the time alone, so two instances
 * agree on which bucket a request belongs to without coordinating. Counting is
 * then one upsert with `$inc` — atomic in the database, so two instances racing
 * on the same key cannot both read "9 of 10" and both allow.
 *
 * That agreement is bought from NTP rather than free. Two hosts whose clocks
 * differ compute different `windowStart` values for the same instant and so
 * write different documents, which reinstates a smaller version of the split
 * quota this store exists to close. Under ordinary time sync the skew is
 * milliseconds and only requests landing that close to a boundary split, so it
 * is a caveat rather than a defect — but an operator debugging a limit that
 * looks doubled should check the clocks before anything else.
 *
 * Fixed windows admit the usual burst across a boundary: a client can spend a
 * full quota at the end of one window and another at the start of the next. That
 * was true of the in-memory version too, and for "how many sign-ins may one
 * address attempt" it is the intended trade for keeping the state one document
 * and one write.
 *
 * Nothing here fails open, in either sense. Past `maxKeys` an unseen key is
 * refused rather than admitted. And if Mongo is unreachable or slow the error
 * propagates — the request 500s, deliberately, rather than being allowed
 * through uncounted or told it was rate limited when it was not. A limiter that
 * cannot count must not hand out unlimited guesses at a password, and a control
 * that switches itself off exactly when the database is in trouble is off at the
 * moment an attacker would most like it off. The cost of that choice is that a
 * Mongo outage takes sign-in with it, which is close to free in practice: the
 * routes behind this limiter read users and write sessions, so a request that
 * cannot reach Mongo was going to fail anyway. `OPERATION_TIMEOUT_MS` is what
 * makes it fail quickly instead of hanging.
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const enabled = options.enabled ?? true;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;

  /*
   * Keys this process has already opened a bucket for, and the window they
   * belong to. It holds no counts — those are in Mongo, which is the point of
   * the change — so it is a cap and a memo, never the quota. Bounded by
   * `maxKeys` and dropped whole on rollover.
   */
  let admittedWindow = -1;
  let admitted = new Set<string>();

  return async function consume(key: string): Promise<void> {
    if (!enabled) return;

    const windowStart = Math.floor(now() / options.windowMs) * options.windowMs;

    if (windowStart !== admittedWindow) {
      admittedWindow = windowStart;
      admitted = new Set();
    }

    if (!admitted.has(key)) {
      if (admitted.size >= maxKeys) throw new TooManyRequestsError(options.message);
      // Recorded before the write rather than after it, so that a key whose
      // write fails still spends its slot. Otherwise a flood that makes Mongo
      // throw would be a flood the cap never counts.
      admitted.add(key);
    }

    const bucket = await rateLimits().findOneAndUpdate(
      { _id: `${options.name}:${windowStart}:${key}` },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date(windowStart + options.windowMs) },
      },
      { upsert: true, returnDocument: 'after', maxTimeMS: OPERATION_TIMEOUT_MS },
    );

    // Upserted, so there is always a document; the null branch is the driver's
    // type, not a case that happens.
    if ((bucket?.count ?? 1) > options.limit) throw new TooManyRequestsError(options.message);
  };
}
