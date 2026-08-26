import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb';
import type {
  AdjustmentReason,
  ItemStatus,
  LocationType,
  MovementType,
  PaymentTerms,
  PriceBreak,
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

  await stockLevels().createIndex(
    { itemId: 1, locationId: 1 },
    { unique: true, name: 'uniq_item_location' },
  );
  await stockLevels().createIndex({ itemId: 1 }, { name: 'by_item' });
}

/**
 * Recompute every on-hand figure from the ledger.
 *
 * The projection is only worth trusting if it can be re-derived, so this exists
 * as much to prove the invariant as to repair it. Safe to run at any time: the
 * ledger is the source of truth and this only rewrites what is downstream of it.
 */
export async function rebuildStockLevels(): Promise<{ levels: number; movements: number }> {
  const totalMovements = await movements().countDocuments({});

  const computed = await movements()
    .aggregate<{
      _id: { itemId: ObjectId; locationId: ObjectId };
      onHand: number;
      locationCode: string;
    }>([
      {
        $group: {
          _id: { itemId: '$itemId', locationId: '$locationId' },
          onHand: { $sum: '$quantity' },
          locationCode: { $last: '$locationCode' },
        },
      },
    ])
    .toArray();

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
