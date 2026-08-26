import { describe, expect, it } from 'vitest';
import { CsvParseError } from './csv.js';
import {
  autoMapColumns,
  ItemImportError,
  itemsToCsv,
  planItemImport,
  readItemCsv,
  summarizeImport,
  type ExistingItem,
  type ItemCsvMapping,
  type ItemImportPlan,
} from './itemCsv.js';
import type { Item } from './item.js';

function existing(overrides: Partial<ExistingItem> = {}): ExistingItem {
  return {
    sku: 'BOLT-M6-30',
    name: 'Hex bolt M6 x 30mm',
    description: 'Zinc plated',
    category: 'Fasteners',
    unitOfMeasure: 'each',
    barcode: '5012345678900',
    unitCostCents: 1250,
    unitPriceCents: 2400,
    reorderPoint: 100,
    reorderQuantity: 500,
    status: 'active',
    attributes: { Colour: 'zinc' },
    ...overrides,
  };
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...existing(),
    ...overrides,
  };
}

function plan(csv: string, current: ExistingItem[] = [], mapping?: ItemCsvMapping): ItemImportPlan {
  const header = csv.split('\n')[0]?.split(',') ?? [];
  const reading = readItemCsv(csv, mapping ?? autoMapColumns(header));
  return planItemImport(
    reading,
    new Map(current.map((entry) => [entry.sku, entry])),
  );
}

describe('autoMapColumns', () => {
  it('maps the exact field names an export writes', () => {
    expect(autoMapColumns(['sku', 'name', 'unitCost', 'attr:Colour'])).toEqual({
      sku: 0,
      name: 1,
      unitCost: 2,
      'attr:Colour': 3,
    });
  });

  it('sees through spacing, case and punctuation in a foreign header', () => {
    expect(autoMapColumns(['Item Code', 'Product Name', 'Cost Price', 'Min Qty'])).toEqual({
      sku: 0,
      name: 1,
      unitCost: 2,
      reorderPoint: 3,
    });
  });

  it('leaves a column it cannot place unmapped rather than guessing', () => {
    expect(autoMapColumns(['sku', 'supplier lead time'])).toEqual({ sku: 0 });
  });

  it('keeps the first of two columns with the same meaning', () => {
    expect(autoMapColumns(['sku', 'Code'])).toEqual({ sku: 0 });
  });
});

describe('planItemImport', () => {
  it('creates an unknown SKU and updates a known one, matching on SKU alone', () => {
    const result = plan(
      'sku,name,unitCost\nBOLT-M6-30,Hex bolt M6 x 30mm,13.00\nNUT-M6,Hex nut M6,0.40\n',
      [existing()],
    );

    expect(result.rows.map((row) => [row.sku, row.action])).toEqual([
      ['BOLT-M6-30', 'update'],
      ['NUT-M6', 'create'],
    ]);
    expect(result.rows[0]?.changedFields).toEqual(['unitCostCents']);
    expect(result.rows[0]?.write).toEqual({
      kind: 'update',
      sku: 'BOLT-M6-30',
      changes: { unitCostCents: 1300 },
    });
  });

  it('uppercases the SKU before matching, so a lowercase re-import is not a duplicate', () => {
    const result = plan('sku,name\nbolt-m6-30,Hex bolt M6 x 30mm\n', [existing()]);
    expect(result.rows[0]?.action).toBe('unchanged');
  });

  it('reports a row that changes nothing as unchanged and gives it no write', () => {
    const result = plan('sku,name,unitCost\nBOLT-M6-30,Hex bolt M6 x 30mm,12.50\n', [existing()]);
    expect(result.rows[0]?.action).toBe('unchanged');
    expect(result.rows[0]?.write).toBeUndefined();
  });

  it('names the line of every row-level failure and leaves the good rows importable', () => {
    const result = plan(
      'sku,name,unitCost\nNUT-M6,Hex nut M6,0.40\n,No SKU,1.00\nWASH M6,Bad SKU,1.00\nPIN-M6,Pin,twelve\n',
      [],
    );

    expect(result.rows.map((row) => [row.line, row.action])).toEqual([
      [2, 'create'],
      [3, 'error'],
      [4, 'error'],
      [5, 'error'],
    ]);
    expect(result.rows[1]?.issues[0]).toEqual({ target: 'sku', message: 'SKU is required' });
    expect(result.rows[3]?.issues[0]?.target).toBe('unitCost');
  });

  it('refuses the second appearance of a SKU and says where the first was', () => {
    const result = plan('sku,name\nNUT-M6,Hex nut\nnut-m6,Hex nut again\n');
    expect(result.rows[1]?.action).toBe('error');
    expect(result.rows[1]?.issues[0]?.message).toContain('line 2');
  });

  it('flags a row with more cells than the header, which is an unescaped comma', () => {
    const result = plan('sku,name\nNUT-M6,Hex nut, M6\n');
    expect(result.rows[0]?.action).toBe('error');
    expect(result.rows[0]?.issues[0]?.message).toContain('3 values');
  });

  it('requires a name to create, but not to update', () => {
    const created = plan('sku,name\nNUT-M6,\n');
    expect(created.rows[0]?.issues[0]).toEqual({ target: 'name', message: 'Name is required' });

    const updated = plan('sku,unitCost\nBOLT-M6-30,13.00\n', [existing()]);
    expect(updated.rows[0]?.action).toBe('update');
  });

  it('treats an empty typed cell as "not supplied" and an empty text cell as empty', () => {
    const result = plan('sku,description,unitCost,unitOfMeasure\nBOLT-M6-30,,,\n', [existing()]);
    expect(result.rows[0]?.changedFields).toEqual(['description']);
    expect(result.rows[0]?.write).toEqual({
      kind: 'update',
      sku: 'BOLT-M6-30',
      changes: { description: '' },
    });
  });

  it('leaves a field alone when the row ends before its column, rather than clearing it', () => {
    // Three headers, one value: the row never mentions description or Colour,
    // so neither may be touched. An empty cell clears; a missing cell does not.
    const result = plan('sku,description,attr:Colour\nBOLT-M6-30\n', [existing()]);
    expect(result.rows[0]?.action).toBe('unchanged');
    expect(result.rows[0]?.changedFields).toEqual([]);
    expect(result.rows[0]?.write).toBeUndefined();
  });

  it('still clears a text field the row wrote as empty, next to one it never reached', () => {
    const result = plan('sku,description,category\nBOLT-M6-30,\n', [existing()]);
    expect(result.rows[0]?.write).toEqual({
      kind: 'update',
      sku: 'BOLT-M6-30',
      changes: { description: '' },
    });
  });

  it('defaults the typed fields a new item leaves unset rather than refusing the row', () => {
    const result = plan('sku,name\nNUT-M6,Hex nut M6\n');
    expect(result.rows[0]?.write).toEqual({
      kind: 'create',
      values: {
        sku: 'NUT-M6',
        name: 'Hex nut M6',
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
      },
    });
  });

  it('merges mapped attributes and removes the ones whose cell is empty', () => {
    const result = plan('sku,attr:Colour,attr:Finish\nBOLT-M6-30,,matte\n', [
      existing({ attributes: { Colour: 'zinc', Grade: '8.8' } }),
    ]);
    expect(result.rows[0]?.write).toEqual({
      kind: 'update',
      sku: 'BOLT-M6-30',
      changes: { attributes: { Grade: '8.8', Finish: 'matte' } },
    });
  });

  it('accepts a currency symbol but refuses a thousands separator rather than guessing', () => {
    const withSymbol = plan('sku,name,unitCost\nNUT-M6,Hex nut,$0.40\n');
    expect(withSymbol.rows[0]?.action).toBe('create');

    const withComma = plan('sku,name,unitCost\nNUT-M6,Hex nut,"1,250.00"\n');
    expect(withComma.rows[0]?.issues[0]?.message).toContain('thousands separator');
  });

  it('reports the columns nothing is mapped to instead of silently dropping them', () => {
    const result = plan('sku,name,supplier lead time\nNUT-M6,Hex nut,14\n');
    expect(result.ignoredColumns).toEqual(['supplier lead time']);
  });

  it('rejects the whole file when it is not CSV', () => {
    expect(() => plan('sku,name\nNUT-M6,"never closed\n')).toThrow(CsvParseError);
  });

  it('refuses a mapping with no SKU column, since SKU is what it matches on', () => {
    expect(() => readItemCsv('name,unitCost\nHex nut,0.40\n', { name: 0 })).toThrow(
      ItemImportError,
    );
  });

  it('refuses a mapping that points past the last column', () => {
    expect(() => readItemCsv('sku,name\nNUT-M6,Hex nut\n', { sku: 0, unitCost: 7 })).toThrow(
      ItemImportError,
    );
  });
});

describe('summarizeImport', () => {
  it('counts the whole file and puts every failure in the rows it returns', () => {
    const result = summarizeImport(
      plan('sku,name\nNUT-M6,Hex nut\nBOLT-M6-30,Hex bolt M6 x 30mm\nWASH M6,Bad SKU\n', [
        existing(),
      ]),
    );

    expect(result).toMatchObject({ totalRows: 3, created: 1, updated: 0, unchanged: 1, failed: 1 });
    expect(result.rows.map((row) => row.line)).toEqual([2, 3, 4]);
    expect(result.rowsTruncated).toBe(false);
  });

  it('never sends the write payload to the client', () => {
    const result = summarizeImport(plan('sku,name\nNUT-M6,Hex nut\n'));
    expect(result.rows[0]).not.toHaveProperty('write');
  });
});

describe('itemsToCsv', () => {
  it('writes exactly the columns an import reads, attributes last and sorted', () => {
    const csv = itemsToCsv([
      item({ attributes: { Grade: '8.8', Colour: 'zinc' } }),
      item({ sku: 'NUT-M6', attributes: {} }),
    ]);
    expect(csv.split('\r\n')[0]).toBe(
      'sku,name,description,category,unitOfMeasure,barcode,unitCost,unitPrice,' +
        'reorderPoint,reorderQuantity,status,attr:Colour,attr:Grade',
    );
  });

  it('round-trips: re-importing an untouched export changes nothing', () => {
    const items = [
      item({ attributes: { Colour: 'zinc' } }),
      item({
        sku: 'NUT-M6',
        name: 'Hex nut, M6',
        description: 'Says 3" on the box',
        unitCostCents: 40,
        unitPriceCents: 99,
        status: 'archived',
        attributes: {},
      }),
    ];

    const csv = itemsToCsv(items);
    const result = plan(csv.replaceAll('\r\n', '\n'), items);

    expect(result.rows.map((row) => row.action)).toEqual(['unchanged', 'unchanged']);
  });
});
