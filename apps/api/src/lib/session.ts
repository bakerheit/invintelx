import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { isProduction } from '../env.js';

export const SESSION_COOKIE = 'invintelx_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** 256 bits of entropy. Guessing is not a threat model we need to worry about. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only the hash is stored. A dump of the sessions collection therefore does not
 * hand an attacker a set of live sessions.
 *
 * Plain SHA-256 is correct here and argon2 would be wrong: the input is already
 * high-entropy random, so there is nothing to brute force, and this runs on
 * every authenticated request.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Lax still sends the cookie on top-level navigation back into the app,
    // which is what a user clicking a bookmarked deep link needs.
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
  });
}
