import {
  ObjectId,
  type ClientSession,
  type Collection,
  type Filter,
  type MatchKeysAndValues,
} from 'mongodb';
import {
  diffAuditFields,
  type AuditAction,
  type AuditChange,
  type AuditEntityType,
} from '@invintelx/shared';
import {
  auditEntries,
  getClient,
  items,
  locations,
  suppliers,
  supplierItems,
  users,
  type AuditEntryDoc,
  type ItemDoc,
  type LocationDoc,
  type SupplierDoc,
  type SupplierItemDoc,
  type UserDoc,
} from '../db.js';

/**
 * The layer that writes edits, and therefore the layer that records them.
 *
 * The ticket's requirement is that a new endpoint cannot forget to write an
 * audit entry. The only way to make that true rather than aspirational is for
 * "write the entry" and "perform the mutation" to be the same call, in the same
 * transaction — so these helpers are how an item, a location, a supplier, a
 * supply line or a user is changed, and there is no second way that skips the
 * record. A route that reaches for `items().findOneAndUpdate` directly is the
 * bug this file exists to make visible in review.
 *
 * Movements are deliberately not here. They have their own append-only ledger
 * in `services/ledger.ts`, which already carries actor, reason and time, and
 * mirroring every movement into a second log would give the same fact two
 * places to disagree.
 */

export interface Actor {
  actorId: ObjectId;
  actorName: string;
}

/** The minimum an entity has to be for a change to it to be recordable. */
interface AuditableDoc {
  _id: ObjectId;
}

/**
 * Everything the log needs to know about one kind of entity: where it lives,
 * what to call it, and how a person recognises one.
 */
export interface AuditSpec<T extends AuditableDoc> {
  entityType: AuditEntityType;
  collection: () => Collection<T>;
  /** How this row names itself in a feed — a SKU, a code, an email. */
  label: (doc: T) => string;
}

export const ITEM_AUDIT: AuditSpec<ItemDoc> = {
  entityType: 'item',
  collection: items,
  label: (doc) => doc.sku,
};

export const LOCATION_AUDIT: AuditSpec<LocationDoc> = {
  entityType: 'location',
  collection: locations,
  label: (doc) => doc.code,
};

export const SUPPLIER_AUDIT: AuditSpec<SupplierDoc> = {
  entityType: 'supplier',
  collection: suppliers,
  label: (doc) => doc.code,
};

export const SUPPLIER_ITEM_AUDIT: AuditSpec<SupplierItemDoc> = {
  entityType: 'supplierItem',
  collection: supplierItems,
  label: (doc) => doc.supplierSku,
};

export const USER_AUDIT: AuditSpec<UserDoc> = {
  entityType: 'user',
  collection: users,
  label: (doc) => doc.email,
};

/**
 * A document as values the log can hold and a browser can render: ids as hex,
 * dates as ISO, everything else as it was.
 *
 * Not merely a serialisation convenience. A cost stored as a BSON int and the
 * same cost read back through JSON have to compare equal, or a re-save with no
 * edit would record a change; going through one representation on the way in is
 * what makes the diff mean what it says.
 */
function toAuditValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toAuditValue);
  if (typeof value === 'object' && (value.constructor === Object || value.constructor === undefined)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toAuditValue(entry),
      ]),
    );
  }
  return value;
}

function toAuditRecord(doc: unknown): Record<string, unknown> {
  const value = toAuditValue(doc);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Run inside a transaction, unless the caller already has one.
 *
 * A bulk import owns its own transaction — all four thousand rows land or none
 * do — and its entries have to land with it. Opening a second session inside
 * that one would make the entries a separate atom, which is exactly the failure
 * mode this whole file is built to prevent.
 */
async function inTransaction<R>(
  run: (session: ClientSession) => Promise<R>,
  existing?: ClientSession,
): Promise<R> {
  if (existing) return run(existing);

  const session = getClient().startSession();
  try {
    let result!: R;
    await session.withTransaction(async () => {
      result = await run(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export interface AuditEventInput {
  actor: Actor;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: ObjectId;
  entityLabel: string;
  changes?: AuditChange[];
}

function buildEntry(input: AuditEventInput, now: Date): AuditEntryDoc {
  return {
    _id: new ObjectId(),
    actorId: input.actor.actorId,
    actorName: input.actor.actorName,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel,
    changes: input.changes ?? [],
    createdAt: now,
  };
}

interface WriteOptions {
  /** Overrides the action the shape of the write implies. */
  action?: AuditAction;
  /** Join a transaction the caller already owns rather than opening one. */
  session?: ClientSession;
  /** Extra changes to merge in, for facts the document diff cannot see. */
  extraChanges?: AuditChange[];
}

function mergeChanges(diffed: AuditChange[], extra: AuditChange[] | undefined): AuditChange[] {
  if (!extra || extra.length === 0) return diffed;
  const byField = new Map(diffed.map((change) => [change.field, change]));
  for (const change of extra) byField.set(change.field, change);
  return [...byField.values()].sort((a, b) => a.field.localeCompare(b.field));
}

/**
 * Insert a document and record its creation. The entry carries every field the
 * new row was given, so "what did this look like when it was set up" is
 * answerable without a second system.
 */
export async function auditedInsert<T extends AuditableDoc>(
  spec: AuditSpec<T>,
  doc: T,
  actor: Actor,
  options: WriteOptions = {},
): Promise<T> {
  await inTransaction(async (session) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await spec.collection().insertOne(doc as any, { session });
    await auditEntries().insertOne(
      buildEntry(
        {
          actor,
          action: options.action ?? 'create',
          entityType: spec.entityType,
          entityId: doc._id,
          entityLabel: spec.label(doc),
          changes: mergeChanges(diffAuditFields({}, toAuditRecord(doc)), options.extraChanges),
        },
        new Date(),
      ),
      { session },
    );
  }, options.session);

  return doc;
}

/**
 * Apply a `$set` and record what it actually changed.
 *
 * The before state is read inside the transaction rather than by the caller, so
 * what the entry says was overwritten is what was overwritten — not what some
 * earlier read believed. A write that changes nothing still writes an entry
 * with an empty `changes` list: somebody pressed save, and a log that quietly
 * drops that cannot be used to say nobody touched it.
 *
 * `updatedAt` is stamped here so no caller can set it, or forget to.
 */
export async function auditedUpdate<T extends AuditableDoc>(
  spec: AuditSpec<T>,
  filter: Filter<T>,
  set: MatchKeysAndValues<T>,
  actor: Actor,
  options: WriteOptions = {},
): Promise<T | null> {
  return inTransaction(async (session) => {
    const before = await spec.collection().findOne(filter, { session });
    if (!before) return null;

    const updated = await spec.collection().findOneAndUpdate(
      // The id, not the caller's filter: the row is already identified, and
      // re-matching on a field the update itself changes would be a race.
      { _id: before._id } as Filter<T>,
      { $set: { ...set, updatedAt: new Date() } as MatchKeysAndValues<T> },
      { returnDocument: 'after', session },
    );
    if (!updated) return null;
    // `WithId<T>` and `T` are the same shape here — AuditableDoc already
    // requires `_id` — but the compiler cannot see that through the generic.
    const after = updated as T;

    await auditEntries().insertOne(
      buildEntry(
        {
          actor,
          action: options.action ?? 'update',
          entityType: spec.entityType,
          entityId: after._id,
          entityLabel: spec.label(after),
          changes: mergeChanges(
            diffAuditFields(toAuditRecord(before), toAuditRecord(after)),
            options.extraChanges,
          ),
        },
        new Date(),
      ),
      { session },
    );

    return after;
  }, options.session);
}

/**
 * Delete a document and record what it held.
 *
 * The entry keeps the whole of the removed row, because a deletion is the one
 * edit where the missing information cannot be recovered from the thing itself.
 */
export async function auditedDelete<T extends AuditableDoc>(
  spec: AuditSpec<T>,
  filter: Filter<T>,
  actor: Actor,
  options: WriteOptions = {},
): Promise<T | null> {
  return inTransaction(async (session) => {
    const deleted = await spec.collection().findOneAndDelete(filter, { session });
    if (!deleted) return null;
    // See auditedUpdate: WithId<T> is T once T is known to carry an `_id`.
    const doc = deleted as T;

    await auditEntries().insertOne(
      buildEntry(
        {
          actor,
          action: options.action ?? 'delete',
          entityType: spec.entityType,
          entityId: doc._id,
          entityLabel: spec.label(doc),
          changes: mergeChanges(diffAuditFields(toAuditRecord(doc), {}), options.extraChanges),
        },
        new Date(),
      ),
      { session },
    );

    return doc;
  }, options.session);
}

/**
 * Entries for a write this module did not perform itself, to be inserted in the
 * caller's transaction.
 *
 * The one legitimate caller is the CSV import, which is a single bulk write of
 * up to twenty thousand rows: routing it through `auditedUpdate` row by row
 * would turn one bulk operation into forty thousand round trips. It still lands
 * in the import's own transaction, so the entries and the items are one atom.
 */
export async function recordAuditEvents(
  inputs: AuditEventInput[],
  session: ClientSession,
): Promise<void> {
  if (inputs.length === 0) return;
  const now = new Date();
  await auditEntries().insertMany(
    inputs.map((input) => buildEntry(input, now)),
    { session },
  );
}

/** Exposed for the import, which builds its diffs from plan values, not documents. */
export function diffAuditDocuments(
  before: unknown,
  after: unknown,
): AuditChange[] {
  return diffAuditFields(toAuditRecord(before), toAuditRecord(after));
}
