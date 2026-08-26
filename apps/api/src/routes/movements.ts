import { Router } from 'express';
import { ObjectId, type Filter } from 'mongodb';
import {
  adjustInputSchema,
  issueInputSchema,
  reverseInputSchema,
  transferInputSchema,
  itemStockSchema,
  listMovementsQuerySchema,
  movementHistoryResponseSchema,
  movementListResponseSchema,
  movementSchema,
  objectIdSchema,
  receiveInputSchema,
} from '@invintelx/shared';
import { movements, type MovementDoc } from '../db.js';
import { NotFoundError, UnauthorizedError } from '../errors.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import { postMovement, postReversal, postTransfer, stockForItem } from '../services/ledger.js';
import { toMovement, toStockLevel } from '../serializers.js';
import { z } from 'zod';

export const movementsRouter: Router = Router();

const postedSchema = z.object({ movement: movementSchema, balanceAfter: z.number().int() });

const transferResponseSchema = z.object({
  out: movementSchema,
  in: movementSchema,
  fromBalance: z.number().int(),
  toBalance: z.number().int(),
});

function actorOf(req: { user?: { id: string; name: string } }) {
  if (!req.user) throw new UnauthorizedError();
  return { actorId: new ObjectId(req.user.id), actorName: req.user.name };
}

movementsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listMovementsQuerySchema, req.query);

    const filter: Filter<MovementDoc> = {};
    if (query.itemId) filter.itemId = new ObjectId(query.itemId);
    if (query.locationId) filter.locationId = new ObjectId(query.locationId);
    if (query.type) filter.type = query.type;

    const skip = (query.page - 1) * query.pageSize;
    const [docs, total] = await Promise.all([
      movements()
        .find(filter)
        .sort({ occurredAt: -1, _id: -1 })
        .skip(skip)
        .limit(query.pageSize)
        .toArray(),
      movements().countDocuments(filter),
    ]);

    res.json(
      movementListResponseSchema.parse({
        data: docs.map(toMovement),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      }),
    );
  }),
);

movementsRouter.post(
  '/receive',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(receiveInputSchema, req.body);
    const result = await postMovement({
      itemId: new ObjectId(input.itemId),
      locationId: new ObjectId(input.locationId),
      quantity: input.quantity,
      type: 'receipt',
      reference: input.reference,
      note: input.note,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      ...actorOf(req),
    });
    res
      .status(201)
      .json(postedSchema.parse({ movement: toMovement(result.movement), balanceAfter: result.balanceAfter }));
  }),
);

movementsRouter.post(
  '/issue',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(issueInputSchema, req.body);
    /*
     * Issuing more than the projection shows is allowed, deliberately.
     *
     * Stock physically leaves before the paperwork catches up, and refusing the
     * entry means it never gets recorded at all — the ledger then diverges from
     * reality silently, which is far worse than a visible negative. The response
     * carries balanceAfter so the UI can warn, and negatives surface as an
     * anomaly rather than being hidden.
     */
    const result = await postMovement({
      itemId: new ObjectId(input.itemId),
      locationId: new ObjectId(input.locationId),
      quantity: -input.quantity,
      type: 'issue',
      reference: input.reference,
      note: input.note,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      ...actorOf(req),
    });
    res
      .status(201)
      .json(postedSchema.parse({ movement: toMovement(result.movement), balanceAfter: result.balanceAfter }));
  }),
);

/**
 * Move stock between two bins. One transaction, two rows, sum zero.
 */
movementsRouter.post(
  '/transfer',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(transferInputSchema, req.body);
    const result = await postTransfer({
      itemId: new ObjectId(input.itemId),
      fromLocationId: new ObjectId(input.fromLocationId),
      toLocationId: new ObjectId(input.toLocationId),
      quantity: input.quantity,
      reference: input.reference,
      note: input.note,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      ...actorOf(req),
    });

    res.status(201).json(
      transferResponseSchema.parse({
        out: toMovement(result.out),
        in: toMovement(result.in),
        fromBalance: result.fromBalance,
        toBalance: result.toBalance,
      }),
    );
  }),
);

/** Write stock on or off with a reason code from a fixed list. */
movementsRouter.post(
  '/adjust',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(adjustInputSchema, req.body);
    const result = await postMovement({
      itemId: new ObjectId(input.itemId),
      locationId: new ObjectId(input.locationId),
      quantity: input.quantity,
      type: 'adjustment',
      reference: '',
      note: input.note,
      reason: input.reason,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      ...actorOf(req),
    });
    res
      .status(201)
      .json(postedSchema.parse({ movement: toMovement(result.movement), balanceAfter: result.balanceAfter }));
  }),
);

/**
 * Correct a mistake by appending its opposite. The original stays.
 */
movementsRouter.post(
  '/:id/reverse',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const parsed = objectIdSchema.safeParse(req.params.id);
    if (!parsed.success) throw new NotFoundError('No movement with that id');
    const input = parseOrThrow(reverseInputSchema, req.body ?? {});

    const result = await postReversal(new ObjectId(parsed.data), input.note, actorOf(req));
    res
      .status(201)
      .json(postedSchema.parse({ movement: toMovement(result.movement), balanceAfter: result.balanceAfter }));
  }),
);

/** On-hand for one item, by location and in total. */
movementsRouter.get(
  '/stock/:itemId',
  asyncHandler(async (req, res) => {
    const parsed = objectIdSchema.safeParse(req.params.itemId);
    if (!parsed.success) throw new NotFoundError('No item with that id');
    const itemId = new ObjectId(parsed.data);

    const { levels, total } = await stockForItem(itemId);
    res.json(
      itemStockSchema.parse({
        itemId: itemId.toHexString(),
        totalOnHand: total,
        byLocation: levels.map(toStockLevel),
      }),
    );
  }),
);

/**
 * One item's history, newest first, with the balance after each movement.
 *
 * The balance is computed by walking back from the current on-hand rather than
 * summing forward from the beginning, so the cost is the page size and not the
 * whole ledger.
 */
movementsRouter.get(
  '/history/:itemId',
  asyncHandler(async (req, res) => {
    const parsed = objectIdSchema.safeParse(req.params.itemId);
    if (!parsed.success) throw new NotFoundError('No item with that id');
    const itemId = new ObjectId(parsed.data);
    const query = parseOrThrow(listMovementsQuerySchema, req.query);

    const filter: Filter<MovementDoc> = { itemId };
    if (query.locationId) filter.locationId = new ObjectId(query.locationId);

    const skip = (query.page - 1) * query.pageSize;
    const [docs, total, newerSum] = await Promise.all([
      movements().find(filter).sort({ occurredAt: -1, _id: -1 }).skip(skip).limit(query.pageSize).toArray(),
      movements().countDocuments(filter),
      /*
       * Everything newer than this page, which has to be undone to get back to
       * the balance as it stood at the top of the page.
       *
       * Guarded: on page one there is nothing newer, and Mongo rejects
       * `$limit: 0` outright rather than treating it as an empty result.
       */
      skip === 0
        ? Promise.resolve(0)
        : movements()
            .aggregate<{ sum: number }>([
              { $match: filter },
              { $sort: { occurredAt: -1, _id: -1 } },
              { $limit: skip },
              { $group: { _id: null, sum: { $sum: '$quantity' } } },
            ])
            .toArray()
            .then((rows) => rows[0]?.sum ?? 0),
    ]);

    const { total: currentOnHand } = await stockForItem(itemId);

    let running = currentOnHand - newerSum;
    const withBalance = docs.map((doc) => {
      const balanceAfter = running;
      running -= doc.quantity;
      return { ...toMovement(doc), balanceAfter };
    });

    res.json(
      movementHistoryResponseSchema.parse({
        data: withBalance,
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      }),
    );
  }),
);
