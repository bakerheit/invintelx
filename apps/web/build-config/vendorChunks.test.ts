import { describe, expect, it } from 'vitest';
import { packageOf, vendorChunk } from './vendorChunks';

/** What pnpm's store actually hands rollup, version stamp and all. */
function storePath(spec: string, pkg: string, file = 'dist/index.mjs'): string {
  return `/repo/node_modules/.pnpm/${spec}/node_modules/${pkg}/${file}`;
}

describe('packageOf', () => {
  it('reads the name past the last node_modules, not the first', () => {
    expect(packageOf(storePath('react@19.2.8', 'react'))).toBe('react');
  });

  it('keeps the scope on a scoped package', () => {
    expect(packageOf(storePath('@radix-ui+react-dialog@1.1.4', '@radix-ui/react-dialog'))).toBe(
      '@radix-ui/react-dialog',
    );
  });

  it('has no opinion about first-party source', () => {
    expect(packageOf('/repo/apps/web/src/features/items/ItemsPage.tsx')).toBeUndefined();
  });
});

describe('vendorChunk', () => {
  it('puts the runtime in one long-lived chunk', () => {
    expect(vendorChunk(storePath('react-dom@19.2.8', 'react-dom'))).toBe('vendor-react');
    expect(vendorChunk(storePath('react-router@7.1.1', 'react-router'))).toBe('vendor-react');
  });

  it('groups the Radix primitives together', () => {
    expect(vendorChunk(storePath('@radix-ui+react-select@2.1.4', '@radix-ui/react-select'))).toBe(
      'vendor-radix',
    );
  });

  /*
   * The one that matters. Slot is reached from screens that are never lazy, so
   * if it stays in the Radix group the whole group is in the first paint.
   */
  it('keeps Slot and its dependency out of the Radix group', () => {
    expect(vendorChunk(storePath('@radix-ui+react-slot@1.3.3', '@radix-ui/react-slot'))).toBe(
      'vendor-react',
    );
    expect(
      vendorChunk(storePath('@radix-ui+react-compose-refs@1.1.1', '@radix-ui/react-compose-refs')),
    ).toBe('vendor-react');
  });

  it('leaves anything unnamed for rollup to place', () => {
    expect(vendorChunk(storePath('clsx@2.1.1', 'clsx'))).toBeUndefined();
    expect(vendorChunk('/repo/apps/web/src/main.tsx')).toBeUndefined();
  });
});
