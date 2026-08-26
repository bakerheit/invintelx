import { createHash, randomBytes } from 'node:crypto';
import type { SetupStatus } from '@invintelx/shared';
import { SETUP_TOKEN_ID, setupTokens, users } from '../db.js';
import { env } from '../env.js';

/**
 * First-administrator bootstrap.
 *
 * `POST /api/auth/register` has to be reachable by someone who has no account
 * yet, which on a self-hosted instance means it is reachable by everyone. If
 * the first registration is also the one that mints the administrator, then
 * deploying the container is the same act as handing it to whoever gets there
 * first. The setup token separates the two: the instance is deployed, and then
 * somebody who can read its log claims it.
 */

/**
 * Plain SHA-256 rather than argon2, for the same reason session tokens use it:
 * the input is already high-entropy random, so there is nothing to brute force.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function hasAnyUser(): Promise<boolean> {
  return (await users().countDocuments({}, { limit: 1 })) > 0;
}

async function storeSetupToken(token: string): Promise<void> {
  await setupTokens().deleteMany({});
  await setupTokens().insertOne({
    _id: SETUP_TOKEN_ID,
    tokenHash: hashToken(token),
    createdAt: new Date(),
  });
}

/** What boot did about the first administrator, so `index.ts` can say it out loud. */
export type SetupAnnouncement =
  /** The instance already has an account. Nothing to claim. */
  | { kind: 'claimed' }
  /** FIRST_ADMIN_SETUP=open: the next registration takes the instance, token or no token. */
  | { kind: 'open' }
  /** The operator supplied SETUP_TOKEN, so there is nothing to print. */
  | { kind: 'pinned' }
  /** A fresh token that exists nowhere else and has to reach the log. */
  | { kind: 'minted'; token: string };

/**
 * Run once at boot, before the server listens.
 *
 * A new token is minted on every boot while the instance is unclaimed. Only the
 * hash is stored, so a token whose log line has scrolled away cannot be
 * recovered — reprinting a fresh one is more use to an operator than a lost one,
 * and the old one stops working the moment this replaces it.
 */
export async function prepareFirstAdminSetup(): Promise<SetupAnnouncement> {
  if (await hasAnyUser()) {
    // An instance with an account has been claimed; a live token would only be
    // a spare key left under the mat.
    await setupTokens().deleteMany({});
    return { kind: 'claimed' };
  }

  if (env.FIRST_ADMIN_SETUP === 'open') {
    await setupTokens().deleteMany({});
    return { kind: 'open' };
  }

  if (env.SETUP_TOKEN) {
    await storeSetupToken(env.SETUP_TOKEN);
    return { kind: 'pinned' };
  }

  // 192 bits. This is the credential that owns the instance, so it is sized
  // like one rather than like something a person is expected to memorise.
  const token = randomBytes(24).toString('base64url');
  await storeSetupToken(token);
  return { kind: 'minted', token };
}

/**
 * Spend the setup token. Returns false if it was wrong, missing, already spent,
 * or never minted — the caller must not create an administrator on a false.
 *
 * The delete *is* the check. Only a caller whose token hashes to the stored
 * value deletes anything, and only one caller can delete it, so the token
 * cannot mint two administrators even if two registrations race. Comparing
 * hashes inside the query rather than in constant time in this process is the
 * same trade the session lookup makes: what is compared is a SHA-256 of a
 * high-entropy secret, and an attacker cannot steer it.
 */
export async function consumeSetupToken(supplied: string | undefined): Promise<boolean> {
  if (env.FIRST_ADMIN_SETUP === 'open') return true;
  if (!supplied) return false;

  const consumed = await setupTokens().findOneAndDelete({
    _id: SETUP_TOKEN_ID,
    tokenHash: hashToken(supplied),
  });
  return consumed !== null;
}

/**
 * What an unauthenticated caller may know: whether the next account is the
 * administrator, and whether claiming it needs the token. Both are things the
 * registration form has to know to be honest about what it is about to do, and
 * neither tells an attacker anything a single registration attempt would not.
 */
export async function getSetupStatus(): Promise<SetupStatus> {
  const firstAccount = !(await hasAnyUser());
  return {
    firstAccount,
    setupTokenRequired: firstAccount && env.FIRST_ADMIN_SETUP === 'token',
  };
}
