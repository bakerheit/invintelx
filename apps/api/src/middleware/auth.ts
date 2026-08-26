import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ROLE_RANK, type PublicUser, type Role } from '@invintelx/shared';
import { ForbiddenError, UnauthorizedError } from '../errors.js';
import { sessions, users } from '../db.js';
import { SESSION_COOKIE, hashSessionToken } from '../lib/session.js';
import { toPublicUser } from '../serializers.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

/**
 * Resolves the session cookie to a user and attaches it. Never rejects - it
 * only populates. Use `requireAuth` to actually gate a route, so that endpoints
 * which behave differently for signed-in users can stay open.
 */
export const loadUser: RequestHandler = (req, _res, next) => {
  void (async () => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) return next();

    const session = await sessions().findOne({ tokenHash: hashSessionToken(token) });
    // The TTL index sweeps periodically rather than instantly, so an expired
    // session can still be present. Check the clock, not just existence.
    if (!session || session.expiresAt.getTime() <= Date.now()) return next();

    const user = await users().findOne({ _id: session.userId });
    if (user) req.user = toPublicUser(user);
    next();
  })().catch(next);
};

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new UnauthorizedError();
  next();
}

/** Roles are ranked, so `requireRole('member')` also admits an admin. */
export function requireRole(minimum: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw new UnauthorizedError();
    if (ROLE_RANK[req.user.role] < ROLE_RANK[minimum]) {
      throw new ForbiddenError(`This action requires the ${minimum} role or higher`);
    }
    next();
  };
}
