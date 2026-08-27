import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb';
import type {
  AdjustmentReason,
  ItemStatus,
  LocationType,
  MovementType,
  PaymentTerms,
  PriceBreak,
  PurchaseOrderStatus,
  Role,
  SupplierContact,
  SupplierStatus,
  UnitOfMeasure,
} from '@invintelx/shared';
import { env } from './env.js';

export interface UserDoc {
  _id: ObjectId;
  /** Always stored lowercased; the unique index depends on it. */
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDoc {
  _id: ObjectId;
  /** SHA-256 of the token. The raw token only ever exists in the cookie. */
  tokenHash: string;
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * The one-shot credential that lets a registration create an instance's
 * administrator. There is only ever one, hence the fixed `_id`: consuming it is
 * a single atomic delete, which is what keeps it one-shot under concurrency.
 */
export interface SetupTokenDoc {
  _id: typeof SETUP_TOKEN_ID;
  /** SHA-256 of the token, for the same reason sessions store a hash. */
  tokenHash: string;
  createdAt: Date;
}

export const SETUP_TOKEN_ID = 'setup';

/** One migration that has run, kept forever so the history is readable. */
export interface AppliedMigrationDoc {
  version: number;
  name: string;
  appliedAt: Date;
  durationMs: number;
}

/**
 * What shape this database is in, and how it got there.
 *
 * Exactly one of these ever exists, hence the fixed `_id`: the whole point is
 * that two processes booting at once contend for the same document rather than
 * each deciding for themselves what has run.
 */
export interface SchemaVersionDoc {
  _id: typeof SCHEMA_VERSION_ID;
  /** Highest migration version applied. 0 means "nothing has run yet". */
  version: number;
  applied: AppliedMigrationDoc[];
  updatedAt: Date;
  /**
   * Held for the duration of a migration run. Null when nobody is migrating.
   * `heartbeatAt` is refreshed while the holder is alive, so a lock left behind
   * by a killed process can be told apart from one that is still working.
   */
  lock: { holder: string; acquiredAt: Date; heartbeatAt: Date } | null;
}

export const SCHEMA_VERSION_ID = 'schema';

export interface ItemDoc {
  _id: ObjectId;
  sku: string;
  name: string;
  description: string;
  category: string;
  unitOfMeasure: UnitOfMeasure;
  barcode: string;
  unitCostCents: number;
  unitPriceCents: number;
  reorderPoint: number;
  reorderQuantity: number;
  status: ItemStatus;
  attributes: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export interface LocationDoc {
  _id: ObjectId;
  code: string;
  name: string;
  type: LocationType;
  parentId: ObjectId | null;
  /** Root first, self last. Enables one indexed query for a whole subtree. */
  path: ObjectId[];
  pathLabel: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierDoc {
  _id: ObjectId;
  code: string;
  name: string;
  status: SupplierStatus;
  contact: SupplierContact;
  paymentTerms: PaymentTerms;
  /** ISO 4217, so the price breaks beneath this supplier mean something. */
  currency: string;
  /** What they say. Never written from observed receipts - see the schema. */
  promisedLeadTimeDays: number;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The join between a supplier and an item, carrying the terms of that one line:
 * their part number for it, and the quantity ladder they price it on.
 */
export interface SupplierItemDoc {
  _id: ObjectId;
  supplierId: ObjectId;
  itemId: ObjectId;
  /** Stored with the supplier's own casing; the unique index is what ignores case. */
  supplierSku: string;
  /** Ascending by minQuantity, canonicalised by the schema on the way in. */
  priceBreaks: PriceBreak[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One line of a purchase order. Lines live inside the order rather than in their
 * own collection: an order has tens of lines and is always read whole, and
 * receiving a delivery has to change several lines and the order's status
 * together — which is one document write here, and a multi-document dance
 * anywhere else.
 */
export interface PurchaseOrderLineDoc {
  _id: ObjectId;
  itemId: ObjectId;
  /** Copied when the line is written. See the schema for why it is not resolved. */
  itemSku: string;
  itemName: string;
  quantityOrdered: number;
  /** Raised by a receipt, lowered by reversing one. May exceed ordered. */
  quantityReceived: number;
  unitCostCents: number;
}

export interface PurchaseOrderDoc {
  _id: ObjectId;
  number: string;
  supplierId: ObjectId;
  /** Copied at creation, for the same reason a line copies its item's SKU. */
  supplierCode: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  expectedDate: Date | null;
  reference: string;
  note: string;
  lines: PurchaseOrderLineDoc[];
  sentAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A named monotonic sequence. `$inc` with an upsert is the entire mechanism:
 * it is atomic, so two orders created at the same instant cannot take the same
 * number. Gaps are expected and harmless — a number handed out to a request that
 * then failed is spent, and reusing it would be worse than skipping it.
 */
export interface CounterDoc {
  _id: string;
  seq: number;
}

export const PURCHASE_ORDER_NUMBER_COUNTER = 'purchaseOrderNumber';

export interface MovementDoc {
  _id: ObjectId;
  itemId: ObjectId;
  itemSku: string;
  itemName: string;
  locationId: ObjectId;
  locationCode: string;
  /** Signed. Positive adds at the location, negative removes. */
  quantity: number;
  type: MovementType;
  reference: string;
  note: string;
  /** Both legs of a transfer share this, so the pair can be found from either. */
  groupId: ObjectId | null;
  /** Set when this row compensates an earlier one. */
  reversesId: ObjectId | null;
  /**
   * Set when this row was posted against a purchase order line. Both are kept:
   * the line id identifies what was satisfied, and the order id makes "every
   * receipt against this order" one indexed query instead of an `$in` over its
   * line ids.
   */
  purchaseOrderId: ObjectId | null;
  purchaseOrderLineId: ObjectId | null;
  /** Only meaningful on an adjustment. */
  reason: AdjustmentReason | null;
  /** When the stock actually moved, which is not always when it was recorded. */
  occurredAt: Date;
  actorId: ObjectId;
  actorName: string;
  createdAt: Date;
}

/**
 * Projection of the ledger, never authored directly. rebuildStockLevels
 * recomputes it from movements, which is what makes it verifiable rather than
 * merely trusted.
 */
export interface StockLevelDoc {
  _id: ObjectId;
  itemId: ObjectId;
  locationId: ObjectId;
  locationCode: string;
  onHand: number;
  updatedAt: Date;
}

let client: MongoClient | undefined;
let db: Db | undefined;

export async function connect(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(env.MONGODB_URI, {
    // Fail fast rather than hanging a request for 30s when Mongo is down.
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  db = client.db(env.MONGODB_DB);
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not connected. Call connect() during bootstrap.');
  return db;
}

export function getClient(): MongoClient {
  if (!client) throw new Error('Database not connected. Call connect() during bootstrap.');
  return client;
}

export async function disconnect(): Promise<void> {
  await client?.close();
  client = undefined;
  db = undefined;
}

export const users = (): Collection<UserDoc> => getDb().collection<UserDoc>('users');
export const sessions = (): Collection<SessionDoc> => getDb().collection<SessionDoc>('sessions');
export const setupTokens = (): Collection<SetupTokenDoc> =>
  getDb().collection<SetupTokenDoc>('setupTokens');
export const items = (): Collection<ItemDoc> => getDb().collection<ItemDoc>('items');
export const locations = (): Collection<LocationDoc> => getDb().collection<LocationDoc>('locations');
export const suppliers = (): Collection<SupplierDoc> => getDb().collection<SupplierDoc>('suppliers');
export const supplierItems = (): Collection<SupplierItemDoc> =>
  getDb().collection<SupplierItemDoc>('supplierItems');
export const movements = (): Collection<MovementDoc> => getDb().collection<MovementDoc>('movements');
export const purchaseOrders = (): Collection<PurchaseOrderDoc> =>
  getDb().collection<PurchaseOrderDoc>('purchaseOrders');
export const counters = (): Collection<CounterDoc> => getDb().collection<CounterDoc>('counters');
export const stockLevels = (): Collection<StockLevelDoc> =>
  getDb().collection<StockLevelDoc>('stockLevels');
export const schemaVersion = (): Collection<SchemaVersionDoc> =>
  getDb().collection<SchemaVersionDoc>('schemaVersion');

/**
 * Idempotent. Run at boot so a fresh database is correct without a migration
 * step, and so the uniqueness guarantees the routes rely on actually exist
 * rather than being assumed.
 */
export async function ensureIndexes(): Promise<void> {
  await users().createIndex({ email: 1 }, { unique: true, name: 'uniq_email' });

  await sessions().createIndex({ tokenHash: 1 }, { unique: true, name: 'uniq_token_hash' });
  await sessions().createIndex({ userId: 1 }, { name: 'by_user' });
  // Mongo's TTL monitor deletes expired sessions on its own sweep, so nothing
  // in the app has to remember to clean up.
  await sessions().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expires' });

  await items().createIndex({ sku: 1 }, { unique: true, name: 'uniq_sku' });
  await items().createIndex({ status: 1, updatedAt: -1 }, { name: 'by_status_updated' });
  await items().createIndex({ category: 1 }, { name: 'by_category' });
  await items().createIndex({ name: 1 }, { name: 'by_name' });

  await locations().createIndex({ code: 1 }, { unique: true, name: 'uniq_code' });
  await locations().createIndex({ parentId: 1 }, { name: 'by_parent' });
  // Subtree queries filter on path membership, so it has to be indexed.
  await locations().createIndex({ path: 1 }, { name: 'by_path' });
  await locations().createIndex({ type: 1, isActive: 1 }, { name: 'by_type_active' });

  await suppliers().createIndex({ code: 1 }, { unique: true, name: 'uniq_code' });
  await suppliers().createIndex({ status: 1, name: 1 }, { name: 'by_status_name' });

  // One line per supplier per item. Two rows for the same pair would give a
  // purchase order two part numbers to choose between.
  await supplierItems().createIndex(
    { supplierId: 1, itemId: 1 },
    { unique: true, name: 'uniq_supplier_item' },
  );
  /*
   * A supplier's part number identifies one product to them, and it identifies
   * the same one whatever case it is typed in. The value is stored as they
   * write it, so case-insensitivity has to live in the index: strength 2
   * compares base letters only, which makes "AB-1" and "ab-1" collide here
   * without either of them being rewritten.
   */
  await supplierItems().createIndex(
    { supplierId: 1, supplierSku: 1 },
    {
      unique: true,
      name: 'uniq_supplier_sku',
      collation: { locale: 'en', strength: 2 },
    },
  );
  // "Who else sells this?" is the question the reorder screen will ask.
  await supplierItems().createIndex({ itemId: 1 }, { name: 'by_item' });

  // The demand series aggregates movements per item over a date window, and the
  // item history page reads one item newest-first. Both are this index.
  await movements().createIndex({ itemId: 1, occurredAt: -1 }, { name: 'by_item_occurred' });
  await movements().createIndex({ locationId: 1, occurredAt: -1 }, { name: 'by_location_occurred' });
  await movements().createIndex({ type: 1, occurredAt: -1 }, { name: 'by_type_occurred' });
  // Sparse: only transfers carry a group, and only reversals carry a target.
  await movements().createIndex({ groupId: 1 }, { name: 'by_group', sparse: true });
  await movements().createIndex({ reversesId: 1 }, { name: 'by_reverses', sparse: true });
  /*
   * Partial rather than sparse. Every movement carries `purchaseOrderId`, null
   * when it was not posted against an order, and a sparse index skips only
   * documents where the field is *missing* — a null is indexed like any other
   * value. Filtering on the type is what actually keeps this index the size of
   * the receipts against purchase orders rather than the size of the ledger.
   */
  await movements().createIndex(
    { purchaseOrderId: 1, occurredAt: -1 },
    {
      name: 'by_purchase_order_occurred',
      partialFilterExpression: { purchaseOrderId: { $type: 'objectId' } },
    },
  );

  await purchaseOrders().createIndex({ number: 1 }, { unique: true, name: 'uniq_number' });
  await purchaseOrders().createIndex({ supplierId: 1, status: 1 }, { name: 'by_supplier_status' });
  // "What is late" and "what is due this week" both read this.
  await purchaseOrders().createIndex({ status: 1, expectedDate: 1 }, { name: 'by_status_expected' });
  // "How much of this SKU is already on the way" reaches into the lines.
  await purchaseOrders().createIndex({ 'lines.itemId': 1 }, { name: 'by_line_item' });
  await purchaseOrders().createIndex({ 'lines._id': 1 }, { name: 'by_line' });

  await stockLevels().createIndex(
    { itemId: 1, locationId: 1 },
    { unique: true, name: 'uniq_item_location' },
  );
  await stockLevels().createIndex({ itemId: 1 }, { name: 'by_item' });
}

interface LedgerTotal {
  _id: { itemId: ObjectId; locationId: ObjectId };
  onHand: number;
  locationCode: string;
}

/**
 * What the ledger sums to, one row per item/location pair that has ever moved.
 *
 * Shared by the rebuild and the check below so that "what the ledger says"
 * cannot quietly mean two different things depending on which one you ran.
 */
async function sumLedgerByItemLocation(): Promise<LedgerTotal[]> {
  return movements()
    .aggregate<LedgerTotal>([
      {
        $group: {
          _id: { itemId: '$itemId', locationId: '$locationId' },
          onHand: { $sum: '$quantity' },
          locationCode: { $last: '$locationCode' },
        },
      },
    ])
    .toArray();
}

/**
 * One item/location pair where the projection and the ledger disagree.
 *
 * `stored` is null when the ledger has movements for a pair the projection has
 * no row for; `ledger` is null when the projection holds a row for a pair the
 * ledger knows nothing about. Both being non-null means the two simply differ.
 */
export interface StockLevelDiscrepancy {
  itemId: ObjectId;
  locationId: ObjectId;
  locationCode: string;
  stored: number | null;
  ledger: number | null;
}

export interface StockLevelVerification {
  /** Rows in the ledger, which is the number a restore is really about. */
  movements: number;
  /** Item/location pairs the ledger implies an on-hand figure for. */
  expectedLevels: number;
  /** Rows the projection actually holds. */
  storedLevels: number;
  /** Sorted by location code, so two runs print the same list in the same order. */
  discrepancies: StockLevelDiscrepancy[];
}

/**
 * Compare the stored projection against what the ledger sums to. Writes nothing.
 *
 * This is the check a restore ends with, and it has to run *before* any rebuild.
 * `rebuildStockLevels` cannot answer "did the restore work": it overwrites
 * on-hand with whatever the restored ledger says, so it agrees with a damaged
 * ledger exactly as readily as an intact one, and leaves no trace of which it
 * was. Comparing first is what turns the answer into evidence — a snapshot whose
 * ledger and projection still agree is a snapshot that was taken consistently.
 *
 * What it cannot tell you is whether the snapshot is *complete*. A dump taken at
 * 02:00 is internally consistent and missing everything that happened after it,
 * and nothing inside the restored database can see the difference.
 */
export async function verifyStockLevels(): Promise<StockLevelVerification> {
  const totalMovements = await movements().countDocuments({});
  const computed = await sumLedgerByItemLocation();

  const key = (itemId: ObjectId, locationId: ObjectId): string =>
    `${itemId.toHexString()}:${locationId.toHexString()}`;

  const fromLedger = new Map(computed.map((row) => [key(row._id.itemId, row._id.locationId), row]));

  const discrepancies: StockLevelDiscrepancy[] = [];
  const seen = new Set<string>();
  let storedLevels = 0;

  // Streamed rather than collected: the ledger totals already sit in memory and
  // the projection is the same order of magnitude, so there is no reason to hold
  // a second copy of it.
  for await (const level of stockLevels().find({})) {
    storedLevels += 1;
    const k = key(level.itemId, level.locationId);
    seen.add(k);

    const expected = fromLedger.get(k);
    if (!expected) {
      discrepancies.push({
        itemId: level.itemId,
        locationId: level.locationId,
        locationCode: level.locationCode,
        stored: level.onHand,
        ledger: null,
      });
    } else if (expected.onHand !== level.onHand) {
      discrepancies.push({
        itemId: level.itemId,
        locationId: level.locationId,
        locationCode: level.locationCode,
        stored: level.onHand,
        ledger: expected.onHand,
      });
    }
  }

  for (const [k, row] of fromLedger) {
    if (seen.has(k)) continue;
    discrepancies.push({
      itemId: row._id.itemId,
      locationId: row._id.locationId,
      locationCode: row.locationCode,
      stored: null,
      ledger: row.onHand,
    });
  }

  discrepancies.sort(
    (a, b) =>
      a.locationCode.localeCompare(b.locationCode) ||
      a.itemId.toHexString().localeCompare(b.itemId.toHexString()),
  );

  return {
    movements: totalMovements,
    expectedLevels: fromLedger.size,
    storedLevels,
    discrepancies,
  };
}

/**
 * Recompute every on-hand figure from the ledger.
 *
 * The projection is only worth trusting if it can be re-derived, so this exists
 * as much to prove the invariant as to repair it. Safe to run at any time: the
 * ledger is the source of truth and this only rewrites what is downstream of it.
 *
 * It is a repair, not a check — see `verifyStockLevels` for the difference.
 */
export async function rebuildStockLevels(): Promise<{ levels: number; movements: number }> {
  const totalMovements = await movements().countDocuments({});
  const computed = await sumLedgerByItemLocation();

  const now = new Date();
  await stockLevels().deleteMany({});
  if (computed.length > 0) {
    await stockLevels().insertMany(
      computed.map((row) => ({
        _id: new ObjectId(),
        itemId: row._id.itemId,
        locationId: row._id.locationId,
        locationCode: row.locationCode,
        onHand: row.onHand,
        updatedAt: now,
      })),
    );
  }

  return { levels: computed.length, movements: totalMovements };
}

export async function healthcheck(): Promise<boolean> {
  try {
    await getDb().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
