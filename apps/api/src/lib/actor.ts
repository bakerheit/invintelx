import { ObjectId } from 'mongodb';
import { UnauthorizedError } from '../errors.js';
import type { Actor } from '../services/audit.js';

/**
 * Who is doing this, as the audit log and the ledger both need it.
 *
 * Throws rather than returning a placeholder. Every write that reaches the
 * audited layer has a real person behind it, and an entry attributed to
 * "system" because a route forgot `requireAuth` would be worse than no entry:
 * it looks like an answer.
 */
export function actorOf(req: { user?: { id: string; name: string } }): Actor {
  if (!req.user) throw new UnauthorizedError();
  return { actorId: new ObjectId(req.user.id), actorName: req.user.name };
}
