import { describe, expect, it } from 'vitest';
import { diffAuditFields, isRedactedAuditField } from './audit.js';

describe('isRedactedAuditField', () => {
  it('matches a secret wherever it is nested', () => {
    expect(isRedactedAuditField('passwordHash')).toBe(true);
    expect(isRedactedAuditField('credentials.passwordHash')).toBe(true);
  });

  it('does not match a field that merely mentions one', () => {
    // The check is on the last path segment, not a substring: an item called
    // "password reset kit" has a name, a cost and no secrets.
    expect(isRedactedAuditField('passwordHint')).toBe(false);
    expect(isRedactedAuditField('name')).toBe(false);
  });
});

describe('diffAuditFields', () => {
  it('reports only the fields that actually moved', () => {
    const changes = diffAuditFields(
      { sku: 'ABC-1', unitCostCents: 500, reorderPoint: 10 },
      { sku: 'ABC-1', unitCostCents: 750, reorderPoint: 10 },
    );

    expect(changes).toEqual([
      { field: 'unitCostCents', before: 500, after: 750, redacted: false },
    ]);
  });

  it('says nothing when a save changed nothing', () => {
    const item = { sku: 'ABC-1', unitCostCents: 500 };
    expect(diffAuditFields(item, { ...item })).toEqual([]);
  });

  it('ignores the fields that move on every write', () => {
    // Otherwise updatedAt is on every entry and buries the one field the
    // argument is actually about.
    const changes = diffAuditFields(
      { _id: 'a', name: 'Bolt', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { _id: 'a', name: 'Bolt', createdAt: '2026-01-01', updatedAt: '2026-08-26' },
    );
    expect(changes).toEqual([]);
  });

  it('names a nested field by its path rather than diffing two objects by eye', () => {
    const changes = diffAuditFields(
      { contact: { name: 'Ada', email: 'ada@example.com' } },
      { contact: { name: 'Ada', email: 'ada@example.org' } },
    );

    expect(changes).toEqual([
      {
        field: 'contact.email',
        before: 'ada@example.com',
        after: 'ada@example.org',
        redacted: false,
      },
    ]);
  });

  it('treats an array as one value, because a price ladder is one decision', () => {
    const changes = diffAuditFields(
      { priceBreaks: [{ minQuantity: 1, unitCostCents: 100 }] },
      { priceBreaks: [{ minQuantity: 1, unitCostCents: 90 }] },
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]?.field).toBe('priceBreaks');
    expect(changes[0]?.after).toEqual([{ minQuantity: 1, unitCostCents: 90 }]);
  });

  it('records a field appearing and a field disappearing, with null on the absent side', () => {
    const changes = diffAuditFields({ barcode: '5012345' }, { category: 'Fixings' });

    expect(changes).toEqual([
      { field: 'barcode', before: '5012345', after: null, redacted: false },
      { field: 'category', before: null, after: 'Fixings', redacted: false },
    ]);
  });

  it('records that a secret changed and never what it changed to', () => {
    const changes = diffAuditFields(
      { email: 'ada@example.com', passwordHash: '$argon2id$before' },
      { email: 'ada@example.com', passwordHash: '$argon2id$after' },
    );

    expect(changes).toEqual([
      { field: 'passwordHash', before: null, after: null, redacted: true },
    ]);
    // The stringified entry is what reaches the database, so assert on that
    // rather than trusting that nothing else on the object carries the value.
    expect(JSON.stringify(changes)).not.toContain('argon2id');
  });

  it('records a newly set secret without its value', () => {
    const changes = diffAuditFields({}, { passwordHash: '$argon2id$brand-new' });
    expect(changes).toEqual([
      { field: 'passwordHash', before: null, after: null, redacted: true },
    ]);
  });

  it('reports a cleared attribute as that attribute going away, not as an object swap', () => {
    const changes = diffAuditFields({ attributes: { colour: 'red' } }, { attributes: {} });

    expect(changes).toEqual([
      { field: 'attributes.colour', before: 'red', after: null, redacted: false },
    ]);
  });

  it('orders changes by field so the same edit always reads the same way', () => {
    const changes = diffAuditFields(
      { unitPriceCents: 1, name: 'a', category: 'x' },
      { unitPriceCents: 2, name: 'b', category: 'y' },
    );

    expect(changes.map((change) => change.field)).toEqual([
      'category',
      'name',
      'unitPriceCents',
    ]);
  });
});
