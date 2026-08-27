import { formatCents, type AuditChange } from '@invintelx/shared';

/**
 * Turning a stored change into a line a person can read.
 *
 * The log stores raw field paths and raw values on purpose — that is what makes
 * it evidence rather than prose, and it means a field added later still records
 * correctly without anybody remembering to teach the log about it. The cost of
 * that decision is paid here, once, in presentation.
 */

/** Fields whose stored value is minor units and whose display is money. */
const MONEY_FIELDS = new Set(['unitCostCents', 'unitPriceCents']);

/** Where camel case and a trailing unit are not the whole story. */
const FIELD_LABELS: Record<string, string> = {
  unitCostCents: 'Unit cost',
  unitPriceCents: 'Unit price',
  sku: 'SKU',
  parentId: 'Parent',
  pathLabel: 'Path',
  promisedLeadTimeDays: 'Promised lead time (days)',
  supplierSku: "Supplier's part number",
  passwordHash: 'Password',
  isActive: 'Active',
};

/**
 * Sentence case, matching every other label in the app: "Reorder point", not
 * "Reorder Point". Anything that needs different capitalisation — an acronym,
 * a unit — is in FIELD_LABELS rather than guessed at here.
 */
function humanise(segment: string): string {
  const spaced = segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * `contact.email` reads as "Contact / Email", so a nested field is visibly
 * nested rather than looking like a top-level one somebody named oddly.
 */
export function fieldLabel(path: string): string {
  const known = FIELD_LABELS[path];
  if (known) return known;

  return path
    .split('.')
    .map((segment) => FIELD_LABELS[segment] ?? humanise(segment))
    .join(' / ');
}

/**
 * A stored value as text.
 *
 * Objects and arrays are shown as compact JSON rather than being unpacked. A
 * price break ladder is one decision and reads as one; inventing a layout for
 * every possible shape would be a lot of code standing between a reader and
 * what was actually recorded.
 */
export function formatAuditValue(path: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value === '') return 'empty';

  const leaf = path.split('.').pop() ?? path;
  if (MONEY_FIELDS.has(leaf) && typeof value === 'number') return formatCents(value);

  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** What a redacted row says instead of a value, in both columns. */
export const REDACTED_PLACEHOLDER = 'not recorded';

export function describeChange(change: AuditChange): {
  label: string;
  before: string;
  after: string;
} {
  if (change.redacted) {
    return {
      label: fieldLabel(change.field),
      before: REDACTED_PLACEHOLDER,
      after: REDACTED_PLACEHOLDER,
    };
  }
  return {
    label: fieldLabel(change.field),
    before: formatAuditValue(change.field, change.before),
    after: formatAuditValue(change.field, change.after),
  };
}
