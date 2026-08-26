import { describe, expect, it } from 'vitest';
import {
  attributeTargetFor,
  mappingFromTargets,
  targetOptions,
  targetsFromMapping,
  UNMAPPED,
} from './importMapping';

describe('targetsFromMapping', () => {
  it('gives every column a choice, including the ones nothing points at', () => {
    expect(targetsFromMapping(['Code', 'Name', 'Lead time'], { sku: 0, name: 1 })).toEqual([
      'sku',
      'name',
      UNMAPPED,
    ]);
  });

  it('round-trips a mapping through the screen unchanged', () => {
    const mapping = { sku: 0, name: 2, 'attr:Grade': 3 };
    const header = ['Code', 'Lead time', 'Name', 'attr:Grade'];
    expect(mappingFromTargets(targetsFromMapping(header, mapping))).toEqual(mapping);
  });
});

describe('mappingFromTargets', () => {
  it('leaves out the columns the user chose not to import', () => {
    expect(mappingFromTargets(['sku', UNMAPPED, 'name'])).toEqual({ sku: 0, name: 2 });
  });
});

describe('attributeTargetFor', () => {
  it('keeps the key an exported attribute column already carries', () => {
    expect(attributeTargetFor('attr:Grade')).toBe('attr:Grade');
  });

  it('names an attribute after a foreign column', () => {
    expect(attributeTargetFor(' Supplier lead time ')).toBe('attr:Supplier lead time');
  });

  it('has nothing to offer for a blank header', () => {
    expect(attributeTargetFor('   ')).toBeNull();
  });
});

describe('targetOptions', () => {
  it('hides a field another column has already claimed', () => {
    const options = targetOptions('Code', 1, ['sku', UNMAPPED]).map((option) => option.value);
    expect(options).not.toContain('sku');
    expect(options).toContain('name');
  });

  it('still offers this column the target it currently holds', () => {
    const options = targetOptions('Code', 0, ['sku', UNMAPPED]).map((option) => option.value);
    expect(options).toContain('sku');
  });

  it('offers an attribute named after the column', () => {
    expect(targetOptions('Grade', 0, [UNMAPPED])).toContainEqual({
      value: 'attr:Grade',
      label: 'Attribute: Grade',
    });
  });
});
