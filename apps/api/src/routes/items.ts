import { Router } from 'express';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import {
  createItemInputSchema,
  CsvParseError,
  itemImportRequestSchema,
  itemListResponseSchema,
  itemsToCsv,
  ItemImportError,
  listItemsQuerySchema,
  objectIdSchema,
  planItemImport,
  readItemCsv,
  summarizeImport,
  updateItemInputSchema,
  type ItemImportPlan,
  type ListItemsQuery,
} from '@invintelx/shared';
import { items, type ItemDoc } from '../db.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { actorOf } from '../lib/actor.js';
import { asyncHandler, parseOrThrow } from '../lib/http.js';
import { requireRole } from '../middleware/auth.js';
import { toItem } from '../serializers.js';
import { auditedInsert, auditedUpdate, ITEM_AUDIT } from '../services/audit.js';
import { applyItemImport, loadExistingBySku, MAX_IMPORT_ROWS } from '../services/itemImport.js';

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

/**
 * The list screen's filters, as a Mongo filter. Shared with the export so that
 * "export" means "the rows I am looking at" rather than something subtly else.
 */
function buildFilter(query: Pick<ListItemsQuery, 'q' | 'category' | 'status'>): Filter<ItemDoc> {
  const filter: Filter<ItemDoc> = {};
  // Default to hiding archived items; asking for them is explicit.
  filter.status = query.status ?? 'active';
  if (query.category) filter.category = query.category;
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [{ sku: rx }, { name: rx }, { barcode: rx }];
  }
  return filter;
}

itemsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listItemsQuerySchema, req.query);
    const filter = buildFilter(query);

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

/** Refused rather than truncated: a short export that looks complete is a trap. */
const MAX_EXPORT_ITEMS = 50_000;

/** Built from its code point rather than written literally: the character is invisible. */
const BOM = String.fromCharCode(0xfeff);

/**
 * The current filter as a file.
 *
 * Registered before `/:id`, which would otherwise match `export.csv` and answer
 * a 404 about an item id nobody asked for.
 */
itemsRouter.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(listItemsQuerySchema, req.query);
    const filter = buildFilter(query);

    const total = await items().countDocuments(filter);
    if (total > MAX_EXPORT_ITEMS) {
      throw new BadRequestError(
        `That is ${total.toLocaleString('en-US')} items. Narrow the filter to ` +
          `${MAX_EXPORT_ITEMS.toLocaleString('en-US')} or fewer and export in parts.`,
      );
    }

    // By SKU, always: an export is a file people diff against the last one.
    const docs = await items().find(filter).sort({ sku: 1 }).toArray();
    const csv = itemsToCsv(docs.map(toItem));

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="items-${stamp}.csv"`);
    /*
     * A byte order mark. Without it Excel reads the file as the local codepage
     * and every accented character in a product name arrives mangled - and this
     * is a file people open in Excel. `parseCsv` strips it again on the way
     * back in, so the round trip is unaffected.
     */
    res.send(BOM + csv);
  }),
);

/**
 * One code in, one item out — what a barcode scanner needs.
 *
 * Deliberately not the `q` search: that one matches substrings across name as
 * well, which is right for somebody typing and wrong for a machine. A scanner
 * has read a complete code and the only honest answers are "this item" or
 * "nothing", because picking the first of eleven partial matches is how the
 * wrong SKU gets stock booked against it.
 *
 * Registered before `/:id` for the same reason `export.csv` is.
 */
const lookupQuerySchema = z.object({
  code: z.string().trim().min(1, 'A code is required').max(64),
});

/** How many exact matches to pull before choosing. SKU is unique; barcode is not. */
const MAX_LOOKUP_CANDIDATES = 10;

itemsRouter.get(
  '/lookup',
  asyncHandler(async (req, res) => {
    const { code } = parseOrThrow(lookupQuerySchema, req.query);
    // SKUs are stored uppercased, so the comparison has to be too — a scanner
    // that reports lower case is otherwise an unrecognised code.
    const sku = code.toUpperCase();

    const docs = await items()
      .find({ $or: [{ sku }, { barcode: code }] })
      .limit(MAX_LOOKUP_CANDIDATES)
      .toArray();

    /*
     * Active beats archived, and a SKU hit beats a barcode hit. Barcodes carry
     * no unique index — a supplier code reused across two items is a real
     * thing — so this has to be an order somebody can predict rather than
     * whatever Mongo returned first.
     */
    const match =
      docs.find((doc) => doc.status === 'active' && doc.sku === sku) ??
      docs.find((doc) => doc.status === 'active') ??
      docs.find((doc) => doc.sku === sku) ??
      docs[0];

    // Archived items come back rather than 404ing. The caller needs to say
    // "that SKU is archived" instead of offering to create a duplicate of it.
    if (!match) throw new NotFoundError(`No item has the SKU or barcode ${code}`);
    res.json(toItem(match));
  }),
);

/**
 * Turn the request into a plan, or into the right refusal.
 *
 * A file that is not CSV takes the whole upload down with it, because there is
 * no such thing as importing part of a file the parser could not read. A row
 * whose *contents* are wrong is a row-level issue and rides back in the preview
 * with its line number, which is what the user needs to go and fix it.
 */
async function planFromRequest(body: unknown): Promise<ItemImportPlan> {
  const input = parseOrThrow(itemImportRequestSchema, body);

  try {
    const reading = readItemCsv(input.csv, input.mapping);
    if (reading.rows.length > MAX_IMPORT_ROWS) {
      throw new BadRequestError(
        `That file has ${reading.rows.length.toLocaleString('en-US')} rows. Split it into ` +
          `files of ${MAX_IMPORT_ROWS.toLocaleString('en-US')} or fewer.`,
      );
    }
    const existing = await loadExistingBySku(reading.skus);
    return planItemImport(reading, existing);
  } catch (error) {
    if (error instanceof CsvParseError) {
      throw new BadRequestError(`Line ${error.line}: ${error.message}`, {
        csv: `Line ${error.line}: ${error.message}`,
      });
    }
    if (error instanceof ItemImportError) throw new BadRequestError(error.message);
    throw error;
  }
}

itemsRouter.post(
  '/import/preview',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    res.json(summarizeImport(await planFromRequest(req.body)));
  }),
);

itemsRouter.post(
  '/import',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const plan = await planFromRequest(req.body);

    /*
     * All or nothing. The ticket's rule for a parse error is the whole file,
     * and the same reasoning holds one level down: a person who uploads four
     * thousand rows wants the four thousand, not "3,986 of them, good luck
     * working out which". They fix the six rows and upload again.
     */
    const failed = plan.rows.filter((row) => row.action === 'error');
    if (failed.length > 0) {
      const fields: Record<string, string> = {};
      for (const row of failed.slice(0, 50)) {
        fields[`line ${row.line}`] = row.issues[0]?.message ?? 'Invalid row';
      }
      throw new BadRequestError(
        `${failed.length} row${failed.length === 1 ? '' : 's'} still need fixing. Nothing was imported.`,
        fields,
      );
    }

    res.json(await applyItemImport(plan, actorOf(req)));
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
    // middleware turns it into a 409, so no pre-check race window here. The
    // audit entry is written in the same transaction, so a refused insert
    // cannot leave a record of an item that does not exist.
    await auditedInsert(ITEM_AUDIT, doc, actorOf(req));
    res.status(201).json(toItem(doc));
  }),
);

itemsRouter.patch(
  '/:id',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(updateItemInputSchema, req.body);
    const doc = await auditedUpdate(
      ITEM_AUDIT,
      { _id: parseId(req.params.id) },
      input,
      actorOf(req),
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
    const doc = await auditedUpdate(
      ITEM_AUDIT,
      { _id: parseId(req.params.id) },
      { status: 'archived' },
      actorOf(req),
      { action: 'archive' },
    );
    if (!doc) throw new NotFoundError('No item with that id');
    res.json(toItem(doc));
  }),
);

itemsRouter.post(
  '/:id/restore',
  requireRole('member'),
  asyncHandler(async (req, res) => {
    const doc = await auditedUpdate(
      ITEM_AUDIT,
      { _id: parseId(req.params.id) },
      { status: 'active' },
      actorOf(req),
      { action: 'restore' },
    );
    if (!doc) throw new NotFoundError('No item with that id');
    res.json(toItem(doc));
  }),
);
