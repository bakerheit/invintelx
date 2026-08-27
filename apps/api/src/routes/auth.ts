import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { loginInputSchema, registerInputSchema } from '@invintelx/shared';
import { sessions, users, type UserDoc } from '../db.js';
import { isTest } from '../env.js';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../errors.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { consumeSetupToken, getSetupStatus } from '../lib/setup.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearSessionCookie,
  generateSessionToken,
  hashSessionToken,
  setSessionCookie,
} from '../lib/session.js';
import { requireAuth } from '../middleware/auth.js';
import { toPublicUser } from '../serializers.js';
import { auditedInsert, USER_AUDIT } from '../services/audit.js';

export const authRouter: Router = Router();

const loginLimiter = createRateLimiter({
  limit: 10,
  windowMs: 15 * 60 * 1000,
  message: 'Too many sign-in attempts. Try again in a few minutes.',
  enabled: !isTest,
});

const registerLimiter = createRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000, enabled: !isTest });

async function startSession(userId: ObjectId) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sessions().insertOne({
    _id: new ObjectId(),
    tokenHash: hashSessionToken(token),
    userId,
    createdAt: new Date(),
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Deliberately unauthenticated: the registration form has to ask this before
 * anyone has an account, and it is the only way that form can say something
 * true about the account it is about to create.
 */
authRouter.get(
  '/setup',
  asyncHandler(async (_req, res) => {
    res.json(await getSetupStatus());
  }),
);

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    registerLimiter(req.ip ?? 'unknown');
    const input = parseOrThrow(registerInputSchema, req.body);

    const existing = await users().findOne({ email: input.email });
    if (existing) {
      throw new ConflictError('That email is already registered', {
        email: 'Already registered',
      });
    }

    // Whoever sets up the instance should not have to hand-edit the database to
    // get an admin. Everyone after them starts as a member.
    const isFirstUser = (await users().countDocuments({}, { limit: 1 })) === 0;

    /*
     * ...but not merely by being first through the door. Deploying an instance
     * and claiming it are two acts, and the setup token is what separates them:
     * without it an exposed instance belongs to whichever stranger reaches it
     * during the minutes between the container coming up and the operator
     * getting round to registering.
     *
     * Spent here, before the insert, so a token that has already made an
     * administrator cannot make a second one.
     */
    if (isFirstUser && !(await consumeSetupToken(input.setupToken))) {
      throw new ForbiddenError(
        'This instance has no administrator yet. Creating one needs the setup token printed in the server log when the API started.',
        { setupToken: 'Missing or incorrect setup token' },
      );
    }

    const now = new Date();

    const doc: UserDoc = {
      _id: new ObjectId(),
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      role: isFirstUser ? ('admin' as const) : ('member' as const),
      createdAt: now,
      updatedAt: now,
    };
    /*
     * Audited, and the actor is the account itself: nobody else exists to
     * attribute a self-registration to. What matters here is the role — an
     * instance's first account is its administrator, and "who made this person
     * an admin" being answerable from the first row is the point.
     *
     * The password hash is on the redaction list, so the entry records that the
     * field was set and nothing about what it was set to.
     */
    await auditedInsert(USER_AUDIT, doc, { actorId: doc._id, actorName: doc.name });

    const { token, expiresAt } = await startSession(doc._id);
    setSessionCookie(res, token, expiresAt);
    res.status(201).json({ user: toPublicUser(doc) });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    loginLimiter(req.ip ?? 'unknown');
    const input = parseOrThrow(loginInputSchema, req.body);

    const user = await users().findOne({ email: input.email });

    // Same message and roughly the same work either way: a faster "no such
    // user" response is a user-enumeration oracle.
    const ok = user
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$notarealsalt$notarealhash', input.password);

    if (!user || !ok) throw new UnauthorizedError('Email or password is incorrect');

    const { token, expiresAt } = await startSession(user._id);
    setSessionCookie(res, token, expiresAt);
    res.json({ user: toPublicUser(user) });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length > 0) {
      await sessions().deleteOne({ tokenHash: hashSessionToken(token) });
    }
    clearSessionCookie(res);
    // Idempotent: logging out when already logged out is a success, not a 401.
    res.status(204).end();
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
