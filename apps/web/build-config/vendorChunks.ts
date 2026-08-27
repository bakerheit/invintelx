/**
 * Which third-party package belongs in which chunk.
 *
 * Only the groups worth naming are here. Everything else — clsx, the icon set,
 * the toast library — is left unassigned so rollup can place it next to
 * whatever uses it. A catch-all `vendor` chunk would do the opposite: it drags
 * a package used by one lazy screen into the first paint of every other one.
 *
 * The names are cache units as much as they are size units. React moves a few
 * times a year and the table library moves on its own schedule; a release that
 * only touches app code should invalidate neither.
 */
const GROUPS: Record<string, string> = {
  // The runtime itself. Nothing renders without it, so it is always in the
  // first paint — which is exactly why it wants its own long-lived chunk.
  react: 'vendor-react',
  'react-dom': 'vendor-react',
  scheduler: 'vendor-react',
  'react-router': 'vendor-react',
  /*
   * Two Radix packages, in the React group on purpose.
   *
   * Slot is what `<Button asChild>` is built on and `compose-refs` is what
   * Slot is built on, so both are reached from the error and not-found
   * screens, which are never lazy. Leaving them in `vendor-radix` pinned that
   * whole group — 36 kB gzipped of dialogs, menus and selects — to the first
   * paint of a login screen that opens none of them. Together they are about
   * two kilobytes, and they behave like part of the runtime, so that is where
   * they live.
   *
   * If another primitive ever gets reached eagerly the same way, the size
   * budget is what says so.
   */
  '@radix-ui/react-slot': 'vendor-react',
  '@radix-ui/react-compose-refs': 'vendor-react',

  '@tanstack/react-query': 'vendor-query',
  '@tanstack/query-core': 'vendor-query',

  // Only the list screens mount a table, and none of them are the first screen
  // anybody sees.
  '@tanstack/react-table': 'vendor-table',
  '@tanstack/table-core': 'vendor-table',

  'react-hook-form': 'vendor-forms',
  '@hookform/resolvers': 'vendor-forms',

  // Shared with the API contract in `packages/shared`, so it is reached from
  // more places than the forms are.
  zod: 'vendor-zod',
};

/**
 * Radix ships one package per primitive and they are one group here, except
 * for anything `GROUPS` has already spoken for.
 */
const RADIX_PREFIX = '@radix-ui/';

/**
 * The installed package a module id belongs to, or `undefined` for first-party
 * source.
 *
 * Takes the *last* `node_modules/` in the path on purpose: pnpm's store puts
 * the real files at `.pnpm/react@19.2.8/node_modules/react/index.js`, and the
 * first segment of that is a version-stamped directory rather than a name.
 */
export function packageOf(id: string): string | undefined {
  const path = id.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const at = path.lastIndexOf(marker);
  if (at === -1) return undefined;

  const [first, second] = path.slice(at + marker.length).split('/');
  if (!first) return undefined;
  if (!first.startsWith('@')) return first;
  return second ? `${first}/${second}` : undefined;
}

/** The manual chunk a module belongs in, or `undefined` to let rollup decide. */
export function vendorChunk(id: string): string | undefined {
  const pkg = packageOf(id);
  if (!pkg) return undefined;

  const named = GROUPS[pkg];
  if (named) return named;

  return pkg.startsWith(RADIX_PREFIX) ? 'vendor-radix' : undefined;
}
