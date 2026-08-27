import { describe, expect, it } from 'vitest';
import { budgetFailures, measureBundle, type EmittedAsset } from './sizeBudget';

function asset(
  fileName: string,
  gzipBytes: number,
  rest: Partial<EmittedAsset> = {},
): EmittedAsset {
  return { fileName, gzipBytes, isEntry: false, staticImports: [], css: [], ...rest };
}

describe('measureBundle', () => {
  it('counts the entry, what it imports synchronously, and its stylesheet', () => {
    const measured = measureBundle([
      asset('index.js', 100, {
        isEntry: true,
        staticImports: ['vendor-react.js'],
        css: ['app.css'],
      }),
      asset('vendor-react.js', 900),
      asset('app.css', 50),
    ]);

    expect(measured.initialBytes).toBe(1050);
    expect(measured.totalBytes).toBe(1050);
  });

  /*
   * The whole point of splitting the routes. A lazily-imported screen is
   * reachable but not downloaded, so a budget that counted it would be blind
   * to the thing it exists to protect.
   */
  it('leaves dynamically imported chunks out of the first paint', () => {
    const measured = measureBundle([
      asset('index.js', 100, { isEntry: true, staticImports: ['vendor-react.js'] }),
      asset('vendor-react.js', 900),
      asset('ItemsPage.js', 7000),
      asset('vendor-table.js', 13000),
    ]);

    expect(measured.initialBytes).toBe(1000);
    expect(measured.totalBytes).toBe(21000);
    expect(measured.initialFiles.map((file) => file.fileName)).toEqual([
      'vendor-react.js',
      'index.js',
    ]);
  });

  it('follows static imports through more than one hop, counting each once', () => {
    const measured = measureBundle([
      asset('index.js', 1, { isEntry: true, staticImports: ['a.js', 'b.js'] }),
      asset('a.js', 10, { staticImports: ['shared.js'] }),
      asset('b.js', 100, { staticImports: ['shared.js'] }),
      asset('shared.js', 1000),
    ]);

    expect(measured.initialBytes).toBe(1111);
  });

  it('survives a cycle between chunks', () => {
    const measured = measureBundle([
      asset('index.js', 1, { isEntry: true, staticImports: ['a.js'] }),
      asset('a.js', 10, { staticImports: ['index.js'] }),
    ]);

    expect(measured.initialBytes).toBe(11);
  });
});

describe('budgetFailures', () => {
  const budget = { initial: 1000, total: 2000 };

  it('passes a bundle inside both ceilings', () => {
    const measured = measureBundle([asset('index.js', 1000, { isEntry: true })]);
    expect(budgetFailures(measured, budget)).toEqual([]);
  });

  it('names the first paint when only the first paint is over', () => {
    const measured = measureBundle([
      asset('index.js', 1001, { isEntry: true }),
      asset('lazy.js', 100),
    ]);

    const failures = budgetFailures(measured, budget);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('first paint');
  });

  /* A dependency that lands in a lazy screen is invisible to the first-paint
   * ceiling, which is what the total is for. */
  it('catches weight that only ever shows up in a lazy chunk', () => {
    const measured = measureBundle([
      asset('index.js', 500, { isEntry: true }),
      asset('lazy.js', 1600),
    ]);

    const failures = budgetFailures(measured, budget);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('in total');
  });
});
