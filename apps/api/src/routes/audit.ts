import { Router } from 'express';
import { ObjectId, type Filter } from 'mongodb';
import {
  auditEntityTypeSchema,
  auditListResponseSchema,
  listAuditQuerySchema,
  objectIdSchema,
} from '@invintelx/shared';
import { auditEntries, type AuditEntryDoc } from '../db.js';
import { NotFoundError } from '../errors.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import { toAuditEntry } from '../serializers.js';

export const auditRouter: Router = Router();

/**
 * Reading the log, in two shapes with two audiences.
 *
 * The global feed is every edit anyone made to anything, which is a report on
 * people as much as on data — so it is admin only. The per-entity trail is the
 * history of one thing the reader is already looking at, and gating that behind
 * an admin would mean the person who has to explain last month's cost cannot see
 * when it changed. They are separate routes rather than one route with a
 * conditional, so the rule is enforced by which handler runs rather than by
 * remembering to check inside a shared one.
 */

async function page(filter: Filter<AuditEntryDoc>, pageNumber: number, pageSize: number) {
  const skip = (pageNumber - 1) * pageSize;
  const [docs, total] = await Promise.all([
    auditEntries()
      // _id descending as the tiebreak: entries written in the same transaction
      // share a timestamp to the millisecond, and a page boundary through them
      // would otherwise repeat or drop rows.
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(pageSize)
      .toArray(),
    auditEntries().countDocuments(filter),
  ]);

  return auditListResponseSchema.parse({
    data: docs.map(toAuditEntry),
    page: pageNumber,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

/** Everything, newest first. Admins only. */
auditRouter.get(
  '/',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listAuditQuerySchema, req.query);

    const filter: Filter<AuditEntryDoc> = {};
    if (query.entityType) filter.entityType = query.entityType;
    if (query.entityId) filter.entityId = new ObjectId(query.entityId);
    if (query.actorId) filter.actorId = new ObjectId(query.actorId);
    if (query.action) filter.action = query.action;

    res.json(await page(filter, query.page, query.pageSize));
  }),
);

/**
 * One entity's history. Any signed-in user, because it is the story of a record
 * they can already read.
 *
 * Nothing is looked up to confirm the entity exists. The log outlives what it
 * describes — a deleted supply line's terms are precisely what somebody comes
 * here for — so an id with no rows is an empty page, not a 404.
 */
auditRouter.get(
  '/:entityType/:entityId',
  asyncHandler(async (req, res) => {
    const entityType = auditEntityTypeSchema.safeParse(req.params.entityType);
    if (!entityType.success) throw new NotFoundError('No such kind of record');

    const entityId = objectIdSchema.safeParse(req.params.entityId);
    if (!entityId.success) throw new NotFoundError('No record with that id');

    const query = parseOrThrow(listAuditQuerySchema, req.query);
    res.json(
      await page(
        { entityType: entityType.data, entityId: new ObjectId(entityId.data) },
        query.page,
        query.pageSize,
      ),
    );
  }),
);
