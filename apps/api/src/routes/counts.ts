import { Router } from 'express';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  cancelCountSheetInputSchema,
  countSheetDetailSchema,
  countSheetListResponseSchema,
  createCountSheetInputSchema,
  listCountSheetsQuerySchema,
  movementSchema,
  objectIdSchema,
  postCountSheetInputSchema,
  recordCountInputSchema,
} from '@invintelx/shared';
import { countSheets, type CountSheetDoc } from '../db.js';
import { NotFoundError, UnauthorizedError } from '../errors.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import {
  cancelCountSheet,
  getCountSheet,
  openCountSheet,
  postCountSheet,
  recordCount,
} from '../services/counts.js';
import { toCountSheet, toCountSheetDetail, toMovement } from '../serializers.js';

export const countsRouter: Router = Router();

/** What accepting the variances wrote, so the screen can show it rather than claim it. */
const postedCountSheetSchema = z.object({
  sheet: countSheetDetailSchema,
  movements: z.array(movementSchema),
  balances: z.array(z.number().int()),
});

function actorOf(req: { user?: { id: string; name: string } }) {
  if (!req.user) throw new UnauthorizedError();
  return { actorId: new ObjectId(req.user.id), actorName: req.user.name };
}

function parseSheetId(raw: unknown): ObjectId {
  const parsed = objectIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundError('No count sheet with that id');
  return new ObjectId(parsed.data);
}

function parseLineId(raw: unknown): ObjectId {
  const parsed = objectIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundError('No line with that id on this sheet');
  return new ObjectId(parsed.data);
}

/**
 * Sheets, newest first, without their lines.
 *
 * The summary each row carries is computed from the lines in this process and
 * the lines then stay here — a list of twenty-five sheets is not a reason to
 * ship twenty-five sheets' worth of SKUs to a browser. Computing it here rather
 * than in an aggregation keeps one implementation of the arithmetic, which is
 * the thing that must not fork.
 */
countsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listCountSheetsQuerySchema, req.query);

    const filter: Filter<CountSheetDoc> = {};
    if (query.status) filter.status = query.status;
    if (query.locationId) filter.locationId = new ObjectId(query.locationId);

    const skip = (query.page - 1) * query.pageSize;
    const [docs, total] = await Promise.all([
      countSheets()
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(query.pageSize)
        .toArray(),
      countSheets().countDocuments(filter),
    ]);

    res.json(
      countSheetListResponseSchema.parse({
        data: docs.map(toCountSheet),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      }),
    );
  }),
);

/** One sheet with every line: the variance report itself. */
countsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const doc = await getCountSheet(parseSheetId(req.params.id));
    res.json(countSheetDetailSchema.parse(toCountSheetDetail(doc)));
  }),
);

/** Cut a sheet for a bin, or for named items in a bin. */
countsRouter.post(
  '/',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createCountSheetInputSchema, req.body);
    const doc = await openCountSheet({
      locationId: new ObjectId(input.locationId),
      itemIds: input.itemIds.map((id) => new ObjectId(id)),
      note: input.note,
      actor: actorOf(req),
    });
    res.status(201).json(countSheetDetailSchema.parse(toCountSheetDetail(doc)));
  }),
);

/** Record what was found on one line, or clear it back to uncounted with null. */
countsRouter.patch(
  '/:id/lines/:lineId',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(recordCountInputSchema, req.body ?? {});
    const doc = await recordCount({
      sheetId: parseSheetId(req.params.id),
      lineId: parseLineId(req.params.lineId),
      countedQuantity: input.countedQuantity,
      actor: actorOf(req),
    });
    res.json(countSheetDetailSchema.parse(toCountSheetDetail(doc)));
  }),
);

/**
 * Accept the named variances. Each one becomes an adjustment carrying the
 * sheet's reference, so a movement can be traced back to the count that caused
 * it, and the sheet closes in the same transaction that writes them.
 */
countsRouter.post(
  '/:id/post',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(postCountSheetInputSchema, req.body ?? {});
    const result = await postCountSheet({
      sheetId: parseSheetId(req.params.id),
      lineIds: input.lineIds.map((id) => new ObjectId(id)),
      note: input.note,
      actor: actorOf(req),
    });

    res.status(201).json(
      postedCountSheetSchema.parse({
        sheet: toCountSheetDetail(result.sheet),
        movements: result.movements.map(toMovement),
        balances: result.balances,
      }),
    );
  }),
);

/** Abandon a sheet. Nothing is written and the counts stay readable. */
countsRouter.post(
  '/:id/cancel',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(cancelCountSheetInputSchema, req.body ?? {});
    const doc = await cancelCountSheet({
      sheetId: parseSheetId(req.params.id),
      note: input.note,
      actor: actorOf(req),
    });
    res.json(countSheetDetailSchema.parse(toCountSheetDetail(doc)));
  }),
);
