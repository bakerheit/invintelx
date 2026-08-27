import { Router } from 'express';
import { MongoServerError, ObjectId, type Filter, type MatchKeysAndValues } from 'mongodb';
import {
  createSupplierInputSchema,
  createSupplierItemInputSchema,
  listSuppliersQuerySchema,
  listSupplierItemsQuerySchema,
  objectIdSchema,
  supplierItemListResponseSchema,
  supplierListResponseSchema,
  updateSupplierInputSchema,
  updateSupplierItemInputSchema,
  type SupplierItem,
} from '@invintelx/shared';
import {
  items,
  supplierItems,
  suppliers,
  type ItemDoc,
  type SupplierDoc,
  type SupplierItemDoc,
} from '../db.js';
import { BadRequestError, ConflictError, NotFoundError } from '../errors.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import { toSupplier, toSupplierItem } from '../serializers.js';

export const suppliersRouter: Router = Router();

/** User input goes into a regex, so metacharacters have to stop being special. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSupplierId(raw: unknown): ObjectId {
  const parsed = objectIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundError('No supplier with that id');
  return new ObjectId(parsed.data);
}

function parseItemId(raw: unknown): ObjectId {
  const parsed = objectIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundError('No item with that id');
  return new ObjectId(parsed.data);
}

/**
 * Case-insensitive on the supplier's own part number, matching the index that
 * enforces its uniqueness. Without it a sort on `supplierSku` cannot use that
 * index and a large catalogue sorts in memory.
 */
const SKU_COLLATION = { locale: 'en', strength: 2 } as const;

async function findSupplierOr404(id: ObjectId): Promise<SupplierDoc> {
  const doc = await suppliers().findOne({ _id: id });
  if (!doc) throw new NotFoundError('No supplier with that id');
  return doc;
}

/**
 * Both unique indexes on `supplierItems` start with `supplierId`, so the
 * generic handler in the error middleware would report the conflict as "that
 * supplierId is already in use" - true of the key, useless to the person. The
 * index is still the guarantee; this only names what it caught.
 */
function asSupplierItemConflict(error: unknown, supplierSku: string): unknown {
  if (!(error instanceof MongoServerError) || error.code !== 11000) return error;
  const pattern = (error.keyPattern ?? {}) as Record<string, unknown>;
  if ('supplierSku' in pattern) {
    return new ConflictError(`This supplier already uses ${supplierSku} for another item`, {
      supplierSku: 'Already used by another line',
    });
  }
  if ('itemId' in pattern) {
    return new ConflictError('This supplier already has a line for that item', {
      itemId: 'Already on this supplier',
    });
  }
  return error;
}

suppliersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listSuppliersQuerySchema, req.query);

    const filter: Filter<SupplierDoc> = {};
    // Default to hiding archived suppliers; asking for them is explicit.
    filter.status = query.status ?? 'active';
    if (query.paymentTerms) filter.paymentTerms = query.paymentTerms;
    if (query.q) {
      const rx = new RegExp(escapeRegex(query.q), 'i');
      filter.$or = [{ code: rx }, { name: rx }, { 'contact.name': rx }, { 'contact.email': rx }];
    }

    const skip = (query.page - 1) * query.pageSize;
    const [docs, total] = await Promise.all([
      suppliers()
        .find(filter)
        // _id is a stable tiebreak, so a page boundary cannot drop or repeat a
        // row when many suppliers share the same sort value.
        .sort({ [query.sort]: query.order === 'asc' ? 1 : -1, _id: 1 })
        .skip(skip)
        .limit(query.pageSize)
        .toArray(),
      suppliers().countDocuments(filter),
    ]);

    // Validating our own response catches contract drift here rather than as a
    // confusing parse failure in the browser.
    res.json(
      supplierListResponseSchema.parse({
        data: docs.map(toSupplier),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      }),
    );
  }),
);

suppliersRouter.post(
  '/',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createSupplierInputSchema, req.body);
    const now = new Date();
    const doc: SupplierDoc = {
      _id: new ObjectId(),
      ...input,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    // A duplicate code surfaces as a 11000 from the unique index and the error
    // middleware turns it into a 409, so no pre-check race window here.
    await suppliers().insertOne(doc);
    res.status(201).json(toSupplier(doc));
  }),
);

/*
 * The supplier's catalogue. Registered ahead of `/:id` only for readability -
 * these paths have an extra segment, so Express tells them apart on its own.
 */
suppliersRouter.get(
  '/:id/items',
  asyncHandler(async (req, res) => {
    const supplierId = parseSupplierId(req.params.id);
    await findSupplierOr404(supplierId);
    const query = parseOrThrow(listSupplierItemsQuerySchema, req.query);

    const filter: Filter<SupplierItemDoc> = { supplierId };
    const skip = (query.page - 1) * query.pageSize;
    const [docs, total] = await Promise.all([
      supplierItems()
        .find(filter)
        .collation(SKU_COLLATION)
        .sort({ supplierSku: 1, _id: 1 })
        .skip(skip)
        .limit(query.pageSize)
        .toArray(),
      supplierItems().countDocuments(filter),
    ]);

    res.json(
      supplierItemListResponseSchema.parse({
        data: await withItems(docs),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      }),
    );
  }),
);

/** One query for the whole page of items, rather than one per line. */
async function withItems(docs: SupplierItemDoc[]): Promise<SupplierItem[]> {
  if (docs.length === 0) return [];
  const itemDocs = await items()
    .find({ _id: { $in: docs.map((doc) => doc.itemId) } })
    .toArray();
  const byId = new Map<string, ItemDoc>(itemDocs.map((doc) => [doc._id.toHexString(), doc]));
  return docs.map((doc) => toSupplierItem(doc, byId.get(doc.itemId.toHexString()) ?? null));
}

suppliersRouter.post(
  '/:id/items',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const supplierId = parseSupplierId(req.params.id);
    await findSupplierOr404(supplierId);
    const input = parseOrThrow(createSupplierItemInputSchema, req.body);

    const item = await items().findOne({ _id: new ObjectId(input.itemId) });
    if (!item) throw new NotFoundError('No item with that id');
    /*
     * An archived item is one the business has stopped carrying. Setting up a
     * fresh supply line for it is almost certainly a mistake, and saying so now
     * is cheaper than discovering it on a purchase order.
     */
    if (item.status === 'archived') {
      throw new BadRequestError('That item is archived. Restore it before sourcing it.', {
        itemId: 'Archived',
      });
    }

    const now = new Date();
    const doc: SupplierItemDoc = {
      _id: new ObjectId(),
      supplierId,
      itemId: item._id,
      supplierSku: input.supplierSku,
      priceBreaks: input.priceBreaks,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await supplierItems().insertOne(doc);
    } catch (error) {
      throw asSupplierItemConflict(error, input.supplierSku);
    }

    res.status(201).json(toSupplierItem(doc, item));
  }),
);

suppliersRouter.patch(
  '/:id/items/:itemId',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const supplierId = parseSupplierId(req.params.id);
    const itemId = parseItemId(req.params.itemId);
    const input = parseOrThrow(updateSupplierItemInputSchema, req.body);

    let doc: SupplierItemDoc | null;
    try {
      doc = await supplierItems().findOneAndUpdate(
        { supplierId, itemId },
        { $set: { ...input, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
    } catch (error) {
      throw asSupplierItemConflict(error, input.supplierSku ?? '');
    }
    if (!doc) throw new NotFoundError('This supplier has no line for that item');

    res.json(toSupplierItem(doc, await items().findOne({ _id: itemId })));
  }),
);

/**
 * Removed outright, unlike an item or a supplier.
 *
 * Nothing historical points at a supply line: it says where the business can
 * buy something today. A purchase order copies the terms it was raised on, so
 * dropping the line cannot rewrite what was ordered.
 */
suppliersRouter.delete(
  '/:id/items/:itemId',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const supplierId = parseSupplierId(req.params.id);
    const itemId = parseItemId(req.params.itemId);

    const doc = await supplierItems().findOneAndDelete({ supplierId, itemId });
    if (!doc) throw new NotFoundError('This supplier has no line for that item');

    res.status(204).end();
  }),
);

suppliersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(toSupplier(await findSupplierOr404(parseSupplierId(req.params.id))));
  }),
);

suppliersRouter.patch(
  '/:id',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const { contact, ...rest } = parseOrThrow(updateSupplierInputSchema, req.body);

    /*
     * Contact fields are set one dotted path at a time. Setting `contact`
     * wholesale would replace the object, so a request that changes only the
     * phone number would delete the email address it did not mention.
     */
    const update: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    for (const [key, value] of Object.entries(contact ?? {})) {
      if (value !== undefined) update[`contact.${key}`] = value;
    }

    const doc = await suppliers().findOneAndUpdate(
      { _id: parseSupplierId(req.params.id) },
      { $set: update as MatchKeysAndValues<SupplierDoc> },
      { returnDocument: 'after' },
    );
    if (!doc) throw new NotFoundError('No supplier with that id');
    res.json(toSupplier(doc));
  }),
);

/**
 * Archive, never delete. A supplier is referenced by supply lines and, once the
 * purchasing epic lands, by orders that were actually placed - so removing one
 * would leave those pointing at nothing.
 */
suppliersRouter.post(
  '/:id/archive',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const doc = await suppliers().findOneAndUpdate(
      { _id: parseSupplierId(req.params.id) },
      { $set: { status: 'archived', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!doc) throw new NotFoundError('No supplier with that id');
    res.json(toSupplier(doc));
  }),
);

suppliersRouter.post(
  '/:id/restore',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const doc = await suppliers().findOneAndUpdate(
      { _id: parseSupplierId(req.params.id) },
      { $set: { status: 'active', updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!doc) throw new NotFoundError('No supplier with that id');
    res.json(toSupplier(doc));
  }),
);
