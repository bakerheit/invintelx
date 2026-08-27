import { z } from 'zod';
import { isoDateSchema, objectIdSchema, paginatedSchema, paginationQuerySchema } from './common.js';

/**
 * The record of every edit that is not a movement.
 *
 * The stock ledger already answers "who changed this number and why". Nothing
 * answered it for a cost, a reorder point, a role or an archival — and those are
 * the edits people argue about after a bad month. This is the same idea applied
 * to everything else: append only, actor on every row, and the before and after
 * of each field that actually changed.
 */

/**
 * What kind of thing an entry is about. Deliberately the domain's own nouns
 * rather than collection names, because this list is read by people.
 */
export const AUDIT_ENTITY_TYPES = [
  'item',
  'location',
  'supplier',
  'supplierItem',
  'user',
] as const;
export const auditEntityTypeSchema = z.enum(AUDIT_ENTITY_TYPES);
export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>;

/**
 * What was done. A closed list for the same reason adjustment reasons are one:
 * free text is how "archived" becomes six different words nobody can total.
 *
 * `roleChange` and `passwordChange` are narrower than `update` on purpose. They
 * are the two edits somebody goes looking for by name, and finding them means
 * filtering a list rather than reading every user update hoping to spot one.
 */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'archive',
  'restore',
  'delete',
  'import',
  'roleChange',
  'passwordChange',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

/**
 * Fields whose *value* is never recorded, whatever entity they turn up on.
 *
 * Matched against the last segment of the field path, so `passwordHash` is
 * covered wherever it is nested. A change to one of these is still an event —
 * it has a field name, an actor and a timestamp — it simply has no before and
 * no after, which is the whole of what the ticket asks for.
 */
export const REDACTED_AUDIT_FIELDS: readonly string[] = [
  'password',
  'passwordHash',
  'setupToken',
  'token',
  'tokenHash',
  'secret',
];

export function isRedactedAuditField(path: string): boolean {
  const leaf = path.split('.').pop() ?? path;
  return REDACTED_AUDIT_FIELDS.includes(leaf);
}

/**
 * One field that changed.
 *
 * `before` and `after` are whatever the field held, flattened to JSON — a
 * number stays a number so a cost change can be read as one. Both are null when
 * `redacted` is true, and null is also a legitimate value, so `redacted` is the
 * flag rather than something inferred from the nulls.
 */
export const auditChangeSchema = z.object({
  /** Dotted path, so `contact.email` is distinguishable from `email`. */
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  /** True when this field's value is never recorded. See REDACTED_AUDIT_FIELDS. */
  redacted: z.boolean(),
});
export type AuditChange = z.infer<typeof auditChangeSchema>;

export const auditEntrySchema = z.object({
  id: objectIdSchema,
  actorId: objectIdSchema,
  actorName: z.string(),
  action: auditActionSchema,
  entityType: auditEntityTypeSchema,
  entityId: objectIdSchema,
  /**
   * How the entity identified itself at the moment of the edit — a SKU, a
   * supplier code, an email. Denormalised deliberately: a feed that has to join
   * to five collections to render a line is a feed that renders nothing once one
   * of those rows is gone, and the whole point is that the record outlives the
   * argument.
   */
  entityLabel: z.string(),
  /** Empty for an event that has no fields, such as an archival. */
  changes: z.array(auditChangeSchema),
  createdAt: isoDateSchema,
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const listAuditQuerySchema = paginationQuerySchema.extend({
  entityType: auditEntityTypeSchema.optional(),
  entityId: objectIdSchema.optional(),
  actorId: objectIdSchema.optional(),
  action: auditActionSchema.optional(),
});
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

export const auditListResponseSchema = paginatedSchema(auditEntrySchema);
export type AuditListResponse = z.infer<typeof auditListResponseSchema>;

/**
 * Fields that are never a *change* worth recording, because they move on every
 * write by construction. `updatedAt` on every row of every entry would bury the
 * one field the argument is actually about.
 */
const IGNORED_AUDIT_FIELDS: readonly string[] = ['_id', 'id', 'createdAt', 'updatedAt'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One level of nesting per dotted key, recursively.
 *
 * A supplier's contact is edited one field at a time, so `contact.email`
 * changing should read as `contact.email` and not as two large objects the
 * reader has to diff by eye. Arrays are left whole: a price break ladder is one
 * decision, and "priceBreaks.2.unitCostCents" is not how anyone thinks about it.
 */
function flatten(value: Record<string, unknown>, prefix = ''): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (IGNORED_AUDIT_FIELDS.includes(path)) continue;
    if (isPlainObject(entry)) {
      /*
       * Only the leaves. An emptied object needs no row of its own — every
       * key it lost is already reported as that key going to null, and a
       * `contact: {} → {}` line alongside them would say nothing twice.
       */
      for (const [nested, nestedValue] of flatten(entry, path)) flat.set(nested, nestedValue);
    } else {
      flat.set(path, entry);
    }
  }
  return flat;
}

/**
 * What changed between two states of the same entity.
 *
 * Both sides must already be JSON-safe — the caller converts ids and dates,
 * because this package has no opinion about Mongo. Equality is structural via
 * JSON, which is sufficient here: every value that reaches it came out of a zod
 * schema, so there are no cycles and no undefined-versus-missing subtleties.
 *
 * A field present on one side only is a change, with the absent side as null.
 * Redacted fields are reported as having changed but never carry their values.
 */
export function diffAuditFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditChange[] {
  const from = flatten(before);
  const to = flatten(after);

  const changes: AuditChange[] = [];
  for (const field of new Set([...from.keys(), ...to.keys()])) {
    const previous = from.has(field) ? (from.get(field) ?? null) : null;
    const current = to.has(field) ? (to.get(field) ?? null) : null;
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;

    changes.push(
      isRedactedAuditField(field)
        ? { field, before: null, after: null, redacted: true }
        : { field, before: previous, after: current, redacted: false },
    );
  }

  // Stable order, so two runs of the same edit print the same entry.
  changes.sort((a, b) => a.field.localeCompare(b.field));
  return changes;
}

/** Human wording for a feed, so the API and the UI cannot drift on it. */
export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  create: 'Created',
  update: 'Edited',
  archive: 'Archived',
  restore: 'Restored',
  delete: 'Deleted',
  import: 'Imported',
  roleChange: 'Changed role',
  passwordChange: 'Changed password',
};

export const AUDIT_ENTITY_LABEL: Record<AuditEntityType, string> = {
  item: 'Item',
  location: 'Location',
  supplier: 'Supplier',
  supplierItem: 'Supply line',
  user: 'User',
};
