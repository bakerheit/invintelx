import { Router } from 'express';
import { ObjectId, type Filter } from 'mongodb';
import {
  createPurchaseOrderInputSchema,
  listPurchaseOrdersQuerySchema,
  objectIdSchema,
  purchaseOrderListResponseSchema,
  purchaseOrderSchema,
  receivePurchaseOrderInputSchema,
  receivePurchaseOrderResponseSchema,
  updatePurchaseOrderInputSchema,
} from '@invintelx/shared';
import { purchaseOrders, type PurchaseOrderDoc } from '../db.js';
import { NotFoundError } from '../errors.js';
import { actorOf } from '../lib/actor.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  receivePurchaseOrder,
  sendPurchaseOrder,
  updatePurchaseOrder,
} from '../services/purchaseOrders.js';
import { toMovement, toPurchaseOrder } from '../serializers.js';

export const purchaseOrdersRouter: Router = Router();

function parseId(raw: unknown): ObjectId {
  const parsed = objectIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundError('No purchase order with that id');
  return new ObjectId(parsed.data);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

purchaseOrdersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listPurchaseOrdersQuerySchema, req.query);

    const filter: Filter<PurchaseOrderDoc> = {};
    if (query.status) filter.status = query.status;
    // "Open" is everything still capable of changing, which is exactly the set
    // the transition table calls non-terminal.
    if (query.open) filter.status = { $in: ['draft', 'sent', 'partial'] };
    if (query.supplierId) filter.supplierId = new ObjectId(query.supplierId);
    if (query.itemId) filter['lines.itemId'] = new ObjectId(query.itemId);
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = [{ number: rx }, { supplierCode: rx }, { supplierName: rx }];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [docs, total] = await Promise.all([
      purchaseOrders()
        .find(filter)
        // `_id` breaks the tie so that paging is stable when several orders
        // share a sort value — every draft raised in the same minute would
        // otherwise be able to swap places between page one and page two.
        .sort({ [query.sort]: query.order === 'asc' ? 1 : -1, _id: -1 })
        .skip(skip)
        .limit(query.pageSize)
        .toArray(),
      purchaseOrders().countDocuments(filter),
    ]);

    res.json(
      purchaseOrderListResponseSchema.parse({
        data: docs.map(toPurchaseOrder),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      }),
    );
  }),
);

purchaseOrdersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const order = await getPurchaseOrder(parseId(req.params.id));
    res.json(purchaseOrderSchema.parse(toPurchaseOrder(order)));
  }),
);

purchaseOrdersRouter.post(
  '/',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createPurchaseOrderInputSchema, req.body);
    const order = await createPurchaseOrder(input);
    res.status(201).json(purchaseOrderSchema.parse(toPurchaseOrder(order)));
  }),
);

purchaseOrdersRouter.patch(
  '/:id',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(updatePurchaseOrderInputSchema, req.body);
    const order = await updatePurchaseOrder(parseId(req.params.id), input);
    res.json(purchaseOrderSchema.parse(toPurchaseOrder(order)));
  }),
);

/** Draft to sent. After this the lines are what the supplier has. */
purchaseOrdersRouter.post(
  '/:id/send',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const order = await sendPurchaseOrder(parseId(req.params.id));
    res.json(purchaseOrderSchema.parse(toPurchaseOrder(order)));
  }),
);

/** Close an order that will not complete. What already arrived stays received. */
purchaseOrdersRouter.post(
  '/:id/cancel',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const order = await cancelPurchaseOrder(parseId(req.params.id));
    res.json(purchaseOrderSchema.parse(toPurchaseOrder(order)));
  }),
);

/**
 * Record a delivery: a receipt movement per line that arrived, and the order
 * advanced to match. Send only the lines that turned up — that is what makes a
 * short shipment ordinary rather than a special case.
 */
purchaseOrdersRouter.post(
  '/:id/receive',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(receivePurchaseOrderInputSchema, req.body);
    const result = await receivePurchaseOrder(parseId(req.params.id), input, actorOf(req));

    res.status(201).json(
      receivePurchaseOrderResponseSchema.parse({
        purchaseOrder: toPurchaseOrder(result.purchaseOrder),
        movements: result.movements.map((posted) => ({
          movement: toMovement(posted.movement),
          balanceAfter: posted.balanceAfter,
        })),
      }),
    );
  }),
);
