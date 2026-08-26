import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rateLimit.js';
import { TooManyRequestsError } from '../errors.js';

describe('createRateLimiter', () => {
  it('allows up to the limit, then rejects', () => {
    const consume = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(() => consume('1.2.3.4')).not.toThrow();
    expect(() => consume('1.2.3.4')).not.toThrow();
    expect(() => consume('1.2.3.4')).not.toThrow();
    expect(() => consume('1.2.3.4')).toThrow(TooManyRequestsError);
  });

  it('tracks each key separately, so one noisy client cannot lock everyone out', () => {
    const consume = createRateLimiter({ limit: 1, windowMs: 60_000 });
    consume('first');
    expect(() => consume('first')).toThrow();
    expect(() => consume('second')).not.toThrow();
  });

  it('lets a blocked key back in once the window rolls over', () => {
    vi.useFakeTimers();
    try {
      const consume = createRateLimiter({ limit: 1, windowMs: 1000 });
      consume('key');
      expect(() => consume('key')).toThrow();
      vi.advanceTimersByTime(1001);
      expect(() => consume('key')).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing at all when disabled', () => {
    const consume = createRateLimiter({ limit: 1, windowMs: 60_000, enabled: false });
    for (let i = 0; i < 50; i += 1) expect(() => consume('key')).not.toThrow();
  });
});
