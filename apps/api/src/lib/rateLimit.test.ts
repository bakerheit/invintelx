import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as DbModule from '../db.js';
import type * as RateLimitModule from './rateLimit.js';
import { TooManyRequestsError } from '../errors.js';

/**
 * Against a real mongod, because the guarantee worth proving is the one the
 * in-memory version could not make: the count is the deployment's count, not one
 * process's. A mock of the collection would happily agree that two limiters
 * sharing a database share a bucket, which is precisely the claim under test.
 */
let mongod: MongoMemoryServer;
let db: typeof DbModule;
let createRateLimiter: typeof RateLimitModule.createRateLimiter;

/**
 * Wide enough that no test which is not *about* the window can roll over into
 * the next one mid-assertion. Windows are aligned to the clock, so a boundary
 * can fall anywhere; an hour makes the odds of it landing between two of these
 * calls small enough to stop being a source of the occasional red build.
 */
const WIDE_WINDOW_MS = 60 * 60 * 1000;

/**
 * A clock the test moves by hand.
 *
 * The limiter takes one because the alternative for a rollover test is a real
 * wait, and a timing-dependent assertion on shared hardware is how a suite goes
 * intermittently red for reasons nobody can reproduce. Fake timers are not the
 * escape: they would freeze the driver's heartbeats along with everything else.
 */
function stubClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'invintelx_ratelimit_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';

  db = await import('../db.js');
  await db.connect();
  await db.ensureIndexes();
  ({ createRateLimiter } = await import('./rateLimit.js'));
}, 120_000);

afterAll(async () => {
  await db?.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await db.rateLimits().deleteMany({});
});

describe('createRateLimiter', () => {
  it('allows up to the limit, then rejects', async () => {
    const consume = createRateLimiter({ name: 'test', limit: 3, windowMs: WIDE_WINDOW_MS });
    await expect(consume('1.2.3.4')).resolves.toBeUndefined();
    await expect(consume('1.2.3.4')).resolves.toBeUndefined();
    await expect(consume('1.2.3.4')).resolves.toBeUndefined();
    await expect(consume('1.2.3.4')).rejects.toThrow(TooManyRequestsError);
  });

  it('tracks each key separately, so one noisy client cannot lock everyone out', async () => {
    const consume = createRateLimiter({ name: 'test', limit: 1, windowMs: WIDE_WINDOW_MS });
    await consume('first');
    await expect(consume('first')).rejects.toThrow();
    await expect(consume('second')).resolves.toBeUndefined();
  });

  it('lets a blocked key back in once the window rolls over', async () => {
    const clock = stubClock();
    const consume = createRateLimiter({
      name: 'test',
      limit: 1,
      windowMs: WIDE_WINDOW_MS,
      now: clock.now,
    });
    await consume('key');
    await expect(consume('key')).rejects.toThrow();
    clock.advance(WIDE_WINDOW_MS);
    await expect(consume('key')).resolves.toBeUndefined();
  });

  it('does nothing at all when disabled', async () => {
    const consume = createRateLimiter({
      name: 'test',
      limit: 1,
      windowMs: WIDE_WINDOW_MS,
      enabled: false,
    });
    for (let i = 0; i < 50; i += 1) await expect(consume('key')).resolves.toBeUndefined();
    // Not merely "never throws": a disabled limiter must not need the database
    // at all, which is what lets the route suite run without one.
    expect(await db.rateLimits().countDocuments({})).toBe(0);
  });

  it('gives two API instances one shared quota rather than one each', async () => {
    // Two limiters over one database is what two processes look like from here.
    const instanceA = createRateLimiter({ name: 'login', limit: 2, windowMs: WIDE_WINDOW_MS });
    const instanceB = createRateLimiter({ name: 'login', limit: 2, windowMs: WIDE_WINDOW_MS });

    await instanceA('9.9.9.9');
    await instanceB('9.9.9.9');
    // The third attempt is over the limit wherever it lands.
    await expect(instanceB('9.9.9.9')).rejects.toThrow(TooManyRequestsError);
    await expect(instanceA('9.9.9.9')).rejects.toThrow(TooManyRequestsError);
  });

  it('keeps two limiters over the same key apart', async () => {
    const login = createRateLimiter({ name: 'login', limit: 1, windowMs: WIDE_WINDOW_MS });
    const register = createRateLimiter({ name: 'register', limit: 1, windowMs: WIDE_WINDOW_MS });

    await login('5.5.5.5');
    await expect(login('5.5.5.5')).rejects.toThrow();
    // Spending the sign-in quota must not spend the registration one.
    await expect(register('5.5.5.5')).resolves.toBeUndefined();
  });

  it('carries the limiter its message', async () => {
    const consume = createRateLimiter({
      name: 'test',
      limit: 1,
      windowMs: WIDE_WINDOW_MS,
      message: 'Too many sign-in attempts. Try again in a few minutes.',
    });
    await consume('key');
    await expect(consume('key')).rejects.toThrow(/Try again in a few minutes/);
  });
});

/**
 * The key is an address the client can influence, so the number of documents a
 * window can hold is a number an attacker would otherwise choose. These are the
 * tests that say it is bounded, and what the bound costs.
 */
describe('key cardinality', () => {
  it('refuses a key it has not seen once the window is full, without writing', async () => {
    const consume = createRateLimiter({
      name: 'test',
      limit: 100,
      windowMs: WIDE_WINDOW_MS,
      maxKeys: 2,
    });
    await consume('1.1.1.1');
    await consume('2.2.2.2');

    await expect(consume('3.3.3.3')).rejects.toThrow(TooManyRequestsError);
    // The refusal is the point; that it cost no storage is the whole point.
    expect(await db.rateLimits().countDocuments({})).toBe(2);
  });

  it('keeps serving the keys it already admitted', async () => {
    const consume = createRateLimiter({
      name: 'test',
      limit: 100,
      windowMs: WIDE_WINDOW_MS,
      maxKeys: 1,
    });
    await consume('1.1.1.1');
    await expect(consume('2.2.2.2')).rejects.toThrow(TooManyRequestsError);
    // A full window locks out strangers, not the clients already inside it.
    await expect(consume('1.1.1.1')).resolves.toBeUndefined();
  });

  it('gets its allowance back when the window rolls over', async () => {
    const clock = stubClock();
    const consume = createRateLimiter({
      name: 'test',
      limit: 100,
      windowMs: WIDE_WINDOW_MS,
      maxKeys: 1,
      now: clock.now,
    });
    await consume('1.1.1.1');
    await expect(consume('2.2.2.2')).rejects.toThrow(TooManyRequestsError);

    clock.advance(WIDE_WINDOW_MS);
    // Otherwise one saturated window would be a permanent lockout.
    await expect(consume('2.2.2.2')).resolves.toBeUndefined();
  });
});

describe('rate limit buckets', () => {
  it('expire on their own, so nothing in the app has to sweep them', async () => {
    const consume = createRateLimiter({ name: 'test', limit: 5, windowMs: WIDE_WINDOW_MS });
    await consume('1.2.3.4');

    const stored = await db.rateLimits().findOne({});
    expect(stored?.expiresAt).toBeInstanceOf(Date);

    const indexes = await db.rateLimits().indexes();
    const ttl = indexes.find((index) => index.name === 'ttl_expires');
    expect(ttl?.key).toEqual({ expiresAt: 1 });
    // Zero means "delete when expiresAt passes", rather than a delay after it.
    expect(ttl?.expireAfterSeconds).toBe(0);
  });
});
