import { MongoClient, type Collection, type Db, type ObjectId } from 'mongodb';
import type { ItemStatus, Role, UnitOfMeasure } from '@invintelx/shared';
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
export const items = (): Collection<ItemDoc> => getDb().collection<ItemDoc>('items');

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
}

export async function healthcheck(): Promise<boolean> {
  try {
    await getDb().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
