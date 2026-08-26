import {
  ATTRIBUTE_COLUMN_PREFIX,
  ITEM_CSV_FIELDS,
  type ItemCsvMapping,
} from '@invintelx/shared';

/**
 * The mapping, turned inside out for the screen.
 *
 * The wire format is target-to-column, because that is the question the server
 * asks: "which column is the SKU?". The screen asks the opposite question, once
 * per column: "what is this?". Keeping both shapes and one pair of pure
 * functions between them is cheaper than making either side pretend.
 */

/** A column the user has chosen not to import. Radix will not take '' as a value. */
export const UNMAPPED = '__unmapped__';

export type ColumnTarget = string;

/** One choice per CSV column, in column order. */
export function targetsFromMapping(header: readonly string[], mapping: ItemCsvMapping): ColumnTarget[] {
  const byColumn = new Map<number, string>();
  for (const [target, index] of Object.entries(mapping)) byColumn.set(index, target);
  return header.map((_column, index) => byColumn.get(index) ?? UNMAPPED);
}

/**
 * The last column claiming a target wins, which cannot happen through the UI —
 * it hides a target already taken — but is worth being deterministic about
 * rather than producing a mapping that depends on object key order.
 */
export function mappingFromTargets(targets: readonly ColumnTarget[]): ItemCsvMapping {
  const mapping: ItemCsvMapping = {};
  for (const [index, target] of targets.entries()) {
    if (target === UNMAPPED) continue;
    mapping[target] = index;
  }
  return mapping;
}

/**
 * The attribute target a column would get, derived from its header: `attr:Grade`
 * keeps `Grade`, and anything else becomes an attribute of its own name. Empty
 * when the header is blank and there is no key to make.
 */
export function attributeTargetFor(header: string): string | null {
  const trimmed = header.trim();
  const key = trimmed.toLowerCase().startsWith(ATTRIBUTE_COLUMN_PREFIX)
    ? trimmed.slice(ATTRIBUTE_COLUMN_PREFIX.length).trim()
    : trimmed;
  return key === '' ? null : `${ATTRIBUTE_COLUMN_PREFIX}${key}`;
}

export const FIELD_LABELS: Record<(typeof ITEM_CSV_FIELDS)[number], string> = {
  sku: 'SKU',
  name: 'Name',
  description: 'Description',
  category: 'Category',
  unitOfMeasure: 'Unit of measure',
  barcode: 'Barcode',
  unitCost: 'Unit cost',
  unitPrice: 'Unit price',
  reorderPoint: 'Reorder point',
  reorderQuantity: 'Reorder quantity',
  status: 'Status',
};

export interface TargetOption {
  value: ColumnTarget;
  label: string;
}

/**
 * What this column may become: nothing, any item field not already spoken for,
 * or an attribute named after the column.
 */
export function targetOptions(
  header: string,
  columnIndex: number,
  targets: readonly ColumnTarget[],
): TargetOption[] {
  const takenElsewhere = new Set(
    targets.filter((target, index) => index !== columnIndex && target !== UNMAPPED),
  );

  const options: TargetOption[] = [{ value: UNMAPPED, label: 'Do not import' }];
  for (const field of ITEM_CSV_FIELDS) {
    if (takenElsewhere.has(field)) continue;
    options.push({ value: field, label: FIELD_LABELS[field] });
  }

  const attribute = attributeTargetFor(header);
  if (attribute !== null && !takenElsewhere.has(attribute)) {
    options.push({
      value: attribute,
      label: `Attribute: ${attribute.slice(ATTRIBUTE_COLUMN_PREFIX.length)}`,
    });
  }

  return options;
}

