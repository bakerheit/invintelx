import { z } from 'zod';
import { parseCsv, serializeCsv, type CsvRecord } from './csv.js';
import { centsToDecimal, decimalToCents } from './money.js';
import { itemStatusSchema, skuSchema, unitOfMeasureSchema, type Item } from './item.js';

/**
 * The CSV contract for items, in both directions.
 *
 * The export writes exactly the columns the import reads, and nothing else. No
 * id, no timestamps: a column that comes out but cannot go back in makes the
 * round trip a lie, and the round trip is the thing that makes anyone trust the
 * import at all.
 */

/** Columns that map to a fixed item field. Order is the export's column order. */
export const ITEM_CSV_FIELDS = [
  'sku',
  'name',
  'description',
  'category',
  'unitOfMeasure',
  'barcode',
  'unitCost',
  'unitPrice',
  'reorderPoint',
  'reorderQuantity',
  'status',
] as const;
export type ItemCsvField = (typeof ITEM_CSV_FIELDS)[number];

/** Anything after this prefix is a key in the item's free-form attributes. */
export const ATTRIBUTE_COLUMN_PREFIX = 'attr:';

const FIELD_SET = new Set<string>(ITEM_CSV_FIELDS);

export function isAttributeTarget(target: string): boolean {
  return target.startsWith(ATTRIBUTE_COLUMN_PREFIX) && target.length > ATTRIBUTE_COLUMN_PREFIX.length;
}

export function isItemCsvTarget(target: string): boolean {
  return FIELD_SET.has(target) || isAttributeTarget(target);
}

/**
 * Which CSV column feeds which item field, as a target-to-column-index map.
 *
 * By index rather than by header text because a real spreadsheet is allowed to
 * have two columns called "Notes", and because the mapping the user confirmed
 * on screen has to mean the same thing when the server re-reads the file.
 */
export const itemCsvMappingSchema = z
  .record(z.string(), z.number().int().min(0))
  .superRefine((mapping, ctx) => {
    for (const target of Object.keys(mapping)) {
      if (!isItemCsvTarget(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${target}" is not an item field or an ${ATTRIBUTE_COLUMN_PREFIX}… column`,
          path: [target],
        });
      }
    }
  });
export type ItemCsvMapping = z.infer<typeof itemCsvMappingSchema>;

export const itemImportRequestSchema = z.object({
  /** The file's text, verbatim. The server re-parses it; it never trusts a client-side parse. */
  csv: z.string().min(1, 'The file is empty'),
  mapping: itemCsvMappingSchema,
});
export type ItemImportRequest = z.infer<typeof itemImportRequestSchema>;

export const ITEM_IMPORT_ACTIONS = ['create', 'update', 'unchanged', 'error'] as const;
export const itemImportActionSchema = z.enum(ITEM_IMPORT_ACTIONS);
export type ItemImportAction = z.infer<typeof itemImportActionSchema>;

export const itemImportIssueSchema = z.object({
  /** The mapping target the message is about, or '' when it is about the row. */
  target: z.string(),
  message: z.string(),
});
export type ItemImportIssue = z.infer<typeof itemImportIssueSchema>;

export const itemImportRowSchema = z.object({
  /** 1-based line in the uploaded file, so the user can go and fix it. */
  line: z.number().int(),
  sku: z.string(),
  name: z.string(),
  action: itemImportActionSchema,
  /** For an update: the fields whose value the file would change. */
  changedFields: z.array(z.string()),
  issues: z.array(itemImportIssueSchema),
});
export type ItemImportRow = z.infer<typeof itemImportRowSchema>;

export const itemImportPreviewSchema = z.object({
  totalRows: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  failed: z.number().int(),
  /** Columns in the file that no mapping points at. Reported, not an error. */
  ignoredColumns: z.array(z.string()),
  rows: z.array(itemImportRowSchema),
  /** True when `rows` is a subset — the counts above are always the whole file. */
  rowsTruncated: z.boolean(),
});
export type ItemImportPreview = z.infer<typeof itemImportPreviewSchema>;

export const itemImportResultSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
});
export type ItemImportResult = z.infer<typeof itemImportResultSchema>;

/**
 * A problem with the file as a whole rather than with one of its rows: no
 * header, no SKU column, a mapping that points past the last column. None of
 * these can be fixed row by row, so none of them are reported that way.
 */
export class ItemImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemImportError';
  }
}

/** The item fields a row can carry, without the parts the database owns. */
export type ItemCsvValues = Omit<Item, 'id' | 'createdAt' | 'updatedAt'>;

const DEFAULTS: Omit<ItemCsvValues, 'sku'> = {
  name: '',
  description: '',
  category: '',
  unitOfMeasure: 'each',
  barcode: '',
  unitCostCents: 0,
  unitPriceCents: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
  status: 'active',
  attributes: {},
};

/** What the planner needs to know about an item that already exists. */
export type ExistingItem = ItemCsvValues;

export interface ItemImportWriteCreate {
  kind: 'create';
  values: ItemCsvValues;
}

export interface ItemImportWriteUpdate {
  kind: 'update';
  sku: string;
  /** Only the fields that actually differ, so an import does not rewrite the world. */
  changes: Partial<ItemCsvValues>;
}

export type ItemImportWrite = ItemImportWriteCreate | ItemImportWriteUpdate;

export interface ItemImportPlanRow extends ItemImportRow {
  /** Absent when the row failed or would change nothing. */
  write?: ItemImportWrite;
}

export interface ItemImportPlan {
  rows: ItemImportPlanRow[];
  ignoredColumns: string[];
  header: string[];
}

/**
 * The file, read and type-checked, but not yet compared against anything that
 * exists. Reading is separated from planning so the caller can look at `skus`
 * and fetch exactly those items — planning cannot ask the database questions,
 * and parsing the file twice to find out which questions to ask would be a
 * silly price to pay for that.
 */
export interface ItemCsvReading {
  header: string[];
  ignoredColumns: string[];
  /** Every valid SKU in the file, deduplicated, in the order they appear. */
  skus: string[];
  rows: ReadItemCsvRow[];
}

export interface ReadItemCsvRow {
  line: number;
  /** How many cells the row actually had, which the header length is checked against. */
  cellCount: number;
  resolution: RowResolution;
}

/*
 * Header aliases. The exact field name is always first, so an export always
 * maps back onto itself; the rest are what other systems actually call these
 * columns. Compared after stripping everything that is not a letter or digit,
 * so "Unit Cost", "unit_cost" and "UNITCOST" are one key.
 */
const HEADER_ALIASES: Record<ItemCsvField, string[]> = {
  sku: ['sku', 'itemsku', 'code', 'itemcode', 'itemnumber', 'partnumber', 'partno'],
  name: ['name', 'itemname', 'title', 'productname'],
  description: ['description', 'desc', 'longdescription'],
  category: ['category', 'categoryname', 'group', 'productgroup'],
  unitOfMeasure: ['unitofmeasure', 'uom', 'unit', 'units', 'measure'],
  barcode: ['barcode', 'ean', 'upc', 'gtin'],
  unitCost: ['unitcost', 'cost', 'costprice', 'buyprice', 'purchaseprice'],
  unitPrice: ['unitprice', 'price', 'sellprice', 'salesprice', 'retailprice'],
  reorderPoint: ['reorderpoint', 'reorderlevel', 'minimumquantity', 'minqty', 'min'],
  reorderQuantity: ['reorderquantity', 'reorderqty', 'orderquantity', 'orderqty'],
  status: ['status', 'state'],
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Guess the mapping from the header row, so the common case — a file this
 * product exported, or one whose columns are named the obvious thing — needs no
 * mapping work at all. The screen still shows every choice and lets it be
 * changed, because a guess presented as a fact is how the wrong column ends up
 * in the price field.
 *
 * First matching column wins: a duplicate header is a spreadsheet accident, and
 * silently preferring the later one would hide it.
 */
export function autoMapColumns(header: readonly string[]): ItemCsvMapping {
  const mapping: ItemCsvMapping = {};

  for (const [index, raw] of header.entries()) {
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();

    if (lower.startsWith(ATTRIBUTE_COLUMN_PREFIX)) {
      const key = trimmed.slice(ATTRIBUTE_COLUMN_PREFIX.length).trim();
      const target = `${ATTRIBUTE_COLUMN_PREFIX}${key}`;
      if (key !== '' && mapping[target] === undefined) mapping[target] = index;
      continue;
    }

    const normalized = normalizeHeader(trimmed);
    if (normalized === '') continue;
    for (const field of ITEM_CSV_FIELDS) {
      if (mapping[field] !== undefined) continue;
      if (HEADER_ALIASES[field].includes(normalized)) {
        mapping[field] = index;
        break;
      }
    }
  }

  return mapping;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function parseWholeNumber(raw: string): Parsed<number> {
  if (!/^\d+$/.test(raw)) return { ok: false, message: 'Must be a whole number of units' };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 1_000_000_000) {
    return { ok: false, message: 'Quantity is implausibly large' };
  }
  return { ok: true, value };
}

/**
 * A money cell as a person writes it. A currency symbol is dropped because
 * spreadsheets add one without being asked; a thousands separator is refused
 * rather than guessed, since "1,50" means one-and-a-half in half of Europe and
 * one hundred and fifty in the other half and neither of us should be betting.
 */
function parseMoneyCents(raw: string): Parsed<number> {
  const stripped = raw.replace(/^[$£€]\s*/, '').trim();
  if (stripped.includes(',')) {
    return { ok: false, message: 'Use a dot for decimals and no thousands separator' };
  }
  if (!/^\d+(\.\d{1,4})?$/.test(stripped)) {
    return { ok: false, message: 'Must be an amount like 12.50' };
  }
  const cents = decimalToCents(Number(stripped));
  if (cents > 1_000_000_000_00) return { ok: false, message: 'Amount is implausibly large' };
  return { ok: true, value: cents };
}

function truncateMessage(field: string, max: number): string {
  return `${field} must be at most ${max} characters`;
}

export interface RowResolution {
  sku: string;
  /** Only the fields the file actually supplied a value for. */
  supplied: Partial<Omit<ItemCsvValues, 'sku' | 'attributes'>>;
  /** Attribute keys to set; a mapped-but-empty cell removes the key instead. */
  attributeSets: Record<string, string>;
  attributeRemovals: string[];
  issues: ItemImportIssue[];
}

/**
 * Read one row through the mapping.
 *
 * The rule for an empty cell, which is the one thing about a CSV importer
 * people get bitten by: for a text field an empty cell means empty, because
 * clearing a description by blanking it in the spreadsheet is what anyone would
 * expect. For a typed field — a unit, a price, a reorder point, a status — an
 * empty cell means "not supplied", so it takes the default on a create and is
 * left alone on an update. Blanking a price to zero by accident costs real
 * money; blanking a description costs nothing.
 */
function resolveRow(record: CsvRecord, mapping: ItemCsvMapping): RowResolution {
  const issues: ItemImportIssue[] = [];
  const supplied: RowResolution['supplied'] = {};
  const attributeSets: Record<string, string> = {};
  const attributeRemovals: string[] = [];

  const cell = (target: string): string | undefined => {
    const index = mapping[target];
    if (index === undefined) return undefined;
    return (record.fields[index] ?? '').trim();
  };

  const fail = (target: string, message: string) => issues.push({ target, message });

  const rawSku = cell('sku') ?? '';
  const parsedSku = skuSchema.safeParse(rawSku);
  const sku = parsedSku.success ? parsedSku.data : '';
  if (!parsedSku.success) fail('sku', parsedSku.error.issues[0]?.message ?? 'Invalid SKU');

  const name = cell('name');
  if (name !== undefined) {
    if (name === '') fail('name', 'Name is required');
    else if (name.length > 200) fail('name', truncateMessage('Name', 200));
    else supplied.name = name;
  }

  const description = cell('description');
  if (description !== undefined) {
    if (description.length > 2000) fail('description', truncateMessage('Description', 2000));
    else supplied.description = description;
  }

  const category = cell('category');
  if (category !== undefined) {
    if (category.length > 100) fail('category', truncateMessage('Category', 100));
    else supplied.category = category;
  }

  const barcode = cell('barcode');
  if (barcode !== undefined) {
    if (barcode.length > 64) fail('barcode', truncateMessage('Barcode', 64));
    else supplied.barcode = barcode;
  }

  const unit = cell('unitOfMeasure');
  if (unit !== undefined && unit !== '') {
    const parsed = unitOfMeasureSchema.safeParse(unit.toLowerCase());
    if (parsed.success) supplied.unitOfMeasure = parsed.data;
    else fail('unitOfMeasure', `"${unit}" is not a unit this system knows`);
  }

  const status = cell('status');
  if (status !== undefined && status !== '') {
    const parsed = itemStatusSchema.safeParse(status.toLowerCase());
    if (parsed.success) supplied.status = parsed.data;
    else fail('status', 'Status must be active or archived');
  }

  /** Runs a cell through a parser and either records the value or the complaint. */
  const takeNumber = (
    target: ItemCsvField,
    parse: (raw: string) => Parsed<number>,
    assign: (value: number) => void,
  ) => {
    const raw = cell(target);
    if (raw === undefined || raw === '') return;
    const parsed = parse(raw);
    if (parsed.ok) assign(parsed.value);
    else fail(target, parsed.message);
  };

  takeNumber('unitCost', parseMoneyCents, (value) => {
    supplied.unitCostCents = value;
  });
  takeNumber('unitPrice', parseMoneyCents, (value) => {
    supplied.unitPriceCents = value;
  });
  takeNumber('reorderPoint', parseWholeNumber, (value) => {
    supplied.reorderPoint = value;
  });
  takeNumber('reorderQuantity', parseWholeNumber, (value) => {
    supplied.reorderQuantity = value;
  });

  for (const target of Object.keys(mapping)) {
    if (!isAttributeTarget(target)) continue;
    const key = target.slice(ATTRIBUTE_COLUMN_PREFIX.length);
    const value = cell(target) ?? '';
    if (value === '') attributeRemovals.push(key);
    else attributeSets[key] = value;
  }

  return { sku, supplied, attributeSets, attributeRemovals, issues };
}

function sameAttributes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/** Rows detailed in a preview response. The counts always cover the whole file. */
export const PREVIEW_ROW_LIMIT = 500;

/**
 * Read the file through the mapping: parse it, type-check every cell, and say
 * which SKUs it mentions. Knows nothing about what already exists.
 *
 * @throws {CsvParseError} when the text is not CSV.
 * @throws {ItemImportError} when the file or the mapping cannot be used at all.
 */
export function readItemCsv(csv: string, mapping: ItemCsvMapping): ItemCsvReading {
  const records = parseCsv(csv);
  const headerRecord = records[0];
  if (!headerRecord) throw new ItemImportError('The file has no header row');
  const header = headerRecord.fields.map((field) => field.trim());

  if (mapping['sku'] === undefined) {
    throw new ItemImportError('Map a column to SKU: it is what an import matches on');
  }
  for (const [target, index] of Object.entries(mapping)) {
    if (index >= header.length) {
      throw new ItemImportError(`${target} is mapped to a column the file does not have`);
    }
  }

  const used = new Set(Object.values(mapping));
  const ignoredColumns = header.filter((name, index) => !used.has(index) && name !== '');

  const rows: ReadItemCsvRow[] = [];
  const skus = new Set<string>();

  for (const record of records.slice(1)) {
    const resolution = resolveRow(record, mapping);
    if (resolution.sku !== '') skus.add(resolution.sku);
    rows.push({ line: record.line, cellCount: record.fields.length, resolution });
  }

  return { header, ignoredColumns, skus: [...skus], rows };
}

/**
 * Decide what the file would do, without doing any of it.
 *
 * Takes the items that already exist rather than reading them itself, which is
 * what makes this a pure function the tests can pin down and the same code path
 * the commit runs — a preview that is computed differently from the write is a
 * preview nobody should believe.
 */
export function planItemImport(
  reading: ItemCsvReading,
  existing: ReadonlyMap<string, ExistingItem>,
): ItemImportPlan {
  const { header, ignoredColumns } = reading;
  const rows: ItemImportPlanRow[] = [];
  const seenSkus = new Map<string, number>();

  for (const record of reading.rows) {
    const { sku, supplied, attributeSets, attributeRemovals } = record.resolution;
    // Copied, so planning the same reading twice cannot accumulate issues on it.
    const issues = [...record.resolution.issues];

    /*
     * More cells than headers is almost always an unescaped comma in this one
     * row. It is that row's problem, not the file's, so it is reported here
     * rather than thrown - the other 3,999 rows are still importable.
     */
    if (record.cellCount > header.length) {
      issues.push({
        target: '',
        message: `This row has ${record.cellCount} values but the header has ${header.length} columns`,
      });
    }

    const duplicateOf = sku === '' ? undefined : seenSkus.get(sku);
    if (duplicateOf !== undefined) {
      issues.push({ target: 'sku', message: `${sku} also appears on line ${duplicateOf}` });
    } else if (sku !== '') {
      seenSkus.set(sku, record.line);
    }

    const current = sku === '' ? undefined : existing.get(sku);

    if (issues.length > 0) {
      rows.push({
        line: record.line,
        sku,
        name: supplied.name ?? current?.name ?? '',
        action: 'error',
        changedFields: [],
        issues,
      });
      continue;
    }

    if (!current) {
      const values: ItemCsvValues = {
        ...DEFAULTS,
        ...supplied,
        sku,
        attributes: attributeSets,
      };
      if (values.name === '') {
        rows.push({
          line: record.line,
          sku,
          name: '',
          action: 'error',
          changedFields: [],
          issues: [{ target: 'name', message: 'Name is required for a new item' }],
        });
        continue;
      }
      rows.push({
        line: record.line,
        sku,
        name: values.name,
        action: 'create',
        changedFields: [],
        issues: [],
        write: { kind: 'create', values },
      });
      continue;
    }

    const attributes = { ...current.attributes, ...attributeSets };
    for (const key of attributeRemovals) delete attributes[key];

    const changes: Partial<ItemCsvValues> = {};
    for (const [key, value] of Object.entries(supplied) as [
      keyof typeof supplied,
      string | number,
    ][]) {
      if (current[key] !== value) Object.assign(changes, { [key]: value });
    }
    if (!sameAttributes(attributes, current.attributes)) changes.attributes = attributes;

    const changedFields = Object.keys(changes);
    rows.push({
      line: record.line,
      sku,
      name: supplied.name ?? current.name,
      action: changedFields.length === 0 ? 'unchanged' : 'update',
      changedFields,
      issues: [],
      ...(changedFields.length === 0 ? {} : { write: { kind: 'update' as const, sku, changes } }),
    });
  }

  return { rows, ignoredColumns, header };
}

/**
 * The plan as the client sees it: counts for the whole file, plus enough rows
 * to look at. Every failing row is included ahead of any successful one,
 * because the failures are the only part the user has to act on.
 */
export function summarizeImport(plan: ItemImportPlan): ItemImportPreview {
  const counts = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const row of plan.rows) counts[row.action] += 1;

  const failed = plan.rows.filter((row) => row.action === 'error');
  const rest = plan.rows.filter((row) => row.action !== 'error');
  const shown = [...failed.slice(0, PREVIEW_ROW_LIMIT)];
  shown.push(...rest.slice(0, Math.max(0, PREVIEW_ROW_LIMIT - shown.length)));
  shown.sort((a, b) => a.line - b.line);

  return {
    totalRows: plan.rows.length,
    created: counts.create,
    updated: counts.update,
    unchanged: counts.unchanged,
    failed: counts.error,
    ignoredColumns: plan.ignoredColumns,
    rows: shown.map(({ write: _write, ...row }) => row),
    rowsTruncated: shown.length < plan.rows.length,
  };
}

/**
 * Render items as CSV. The header is the fixed fields followed by one column
 * per attribute key seen anywhere in the set, sorted, so two exports of the
 * same data are byte-identical and a diff means something.
 */
export function itemsToCsv(items: readonly Item[]): string {
  const attributeKeys = [
    ...new Set(items.flatMap((item) => Object.keys(item.attributes))),
  ].sort((a, b) => a.localeCompare(b));

  const header = [
    ...ITEM_CSV_FIELDS,
    ...attributeKeys.map((key) => `${ATTRIBUTE_COLUMN_PREFIX}${key}`),
  ];

  const rows = items.map((item) => [
    item.sku,
    item.name,
    item.description,
    item.category,
    item.unitOfMeasure,
    item.barcode,
    centsToDecimal(item.unitCostCents).toFixed(2),
    centsToDecimal(item.unitPriceCents).toFixed(2),
    String(item.reorderPoint),
    String(item.reorderQuantity),
    item.status,
    ...attributeKeys.map((key) => item.attributes[key] ?? ''),
  ]);

  return serializeCsv([header, ...rows]);
}
