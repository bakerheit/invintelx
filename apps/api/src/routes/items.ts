import { Router } from 'express';
import { ObjectId, type Filter } from 'mongodb';
import {
  createItemInputSchema,
  itemListResponseSchema,
  listItemsQuerySchema,
  objectIdSchema,
  updateItemInputSchema,
} from '@invintelx/shared';
import { items, type ItemDoc } from '../db.js';
import { NotFoundError } from '../errors.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import { toItem } from '../serializers.js';

export const itemsRouter: Router = Router();

/** User input goes into a regex, so metacharacters have to stop being special. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Express 5 types a route param as `string | string[]`, since a repeated param
 * is legal at the HTTP level. Take `unknown` and let the schema be the gate -
 * anything that is not a 24-char hex string is simply not a thing that exists.
 */
function parseId(raw: unknown): ObjectId {
  const parsed = objectIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundError('No item with that id');
  return new ObjectId(parsed.data);
}

itemsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listItemsQuerySchema, req.query);

    const filter: Filter<ItemDoc> = {};
    // Default to hiding archived items; asking for them is explicit.
    filter.status = query.status ?? 'active';
    if (query.category) filter.category = query.category;
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = [{ sku: rx }, { name: rx }, { barcode: rx }];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [docs, total] = await Promise.all([
      items()
        .find(filter)
        // _id is a stable tiebreak, so a page boundary cannot drop or repeat a
        // row when many items share the same sort value.
        .sort({ [query.sort]: query.order === 'asc' ? 1 : -1, _id: 1 })
        .skip(skip)
        .limit(query.pageSize)
        .toArray(),
      items().countDocuments(filter),
    ]);

    const body = {
      data: docs.map(toItem),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
    // Validating our own response catches contract drift here rather than as a
    // confusing parse failure in the browser.
    res.json(itemListResponseSchema.parse(body));
  }),
);

itemsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const doc = await items().findOne({ _id: parseId(req.params.id) });
    if (!doc) throw new NotFoundError('No item with that id');
    res.json(toItem(doc));
  }),
);

itemsRouter.post(
  '/',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createItemInputSchema, req.body);
    const now = new Date();
    const doc: ItemDoc = {
      _id: new ObjectId(),
      ...input,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    // A duplicate SKU surfaces as a 11000 from the unique index and the error
    // middleware turns it into a 409, so no pre-check race window here.
    await items().insertOne(doc);
    res.status(201).json(toItem(doc));
  }),
);

itemsRouter.patch(
  '/:id',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(updateItemInputSchema, req.body);
    const doc = await items().findOneAndUpdate(
      { _id: parseId(req.params.id) },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!doc) throw new NotFoundError('No item with that id');
    res.json(toItem(doc));
  }),
);

/**
 * Archive, never delete. Once a movement references an item, removing the item
 * would leave the ledger pointing at nothing - and the ledger is the part that
 * has to stay true.
 */
itemsRouter.post(
  '/:id/archive',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const doc = await items().findOneAndUpdate(
      { _id: parseId(req.params.id) },
      { $set: { status: 'archived', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!doc) throw new NotFoundError('No item with that id');
    res.json(toItem(doc));
  }),
);

itemsRouter.post(
  '/:id/restore',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const doc = await items().findOneAndUpdate(
      { _id: parseId(req.params.id) },
      { $set: { status: 'active', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!doc) throw new NotFoundError('No item with that id');
    res.json(toItem(doc));
  }),
);
