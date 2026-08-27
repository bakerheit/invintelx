import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/**
 * Gzipped byte ceilings for the production bundle.
 *
 * `initial` is the number that decides how long a warehouse tablet stares at a
 * white screen: the entry chunk, everything it imports synchronously, and the
 * stylesheets that come with them. `total` is the whole build, which catches a
 * dependency that lands in a lazy screen and would otherwise be invisible here.
 */
export interface SizeBudget {
  initial: number;
  total: number;
}

/** One emitted file, reduced to the parts a budget cares about. */
export interface EmittedAsset {
  fileName: string;
  gzipBytes: number;
  isEntry: boolean;
  /** Chunks pulled in synchronously. Dynamic imports are excluded on purpose. */
  staticImports: readonly string[];
  /** Stylesheets that ship with this chunk. */
  css: readonly string[];
}

export interface Measurement {
  initialBytes: number;
  totalBytes: number;
  /** The files making up the first paint, largest first. */
  initialFiles: readonly { fileName: string; gzipBytes: number }[];
}

/**
 * What a first-time visitor downloads, and what the build weighs in total.
 *
 * The first paint is found by walking static imports out from the entry
 * chunks. A dynamically imported chunk is reachable but not downloaded, which
 * is the whole point of splitting the routes — counting it would make the
 * budget blind to the thing it exists to protect.
 */
export function measureBundle(assets: readonly EmittedAsset[]): Measurement {
  const byName = new Map(assets.map((asset) => [asset.fileName, asset]));

  const initial = new Set<string>();
  const queue = assets.filter((asset) => asset.isEntry).map((asset) => asset.fileName);

  while (queue.length > 0) {
    const fileName = queue.shift();
    if (fileName === undefined || initial.has(fileName)) continue;
    initial.add(fileName);

    const asset = byName.get(fileName);
    if (!asset) continue;
    queue.push(...asset.staticImports, ...asset.css);
  }

  const initialFiles = [...initial]
    .map((fileName) => byName.get(fileName))
    .filter((asset): asset is EmittedAsset => asset !== undefined)
    .map((asset) => ({ fileName: asset.fileName, gzipBytes: asset.gzipBytes }))
    .sort((a, b) => b.gzipBytes - a.gzipBytes);

  return {
    initialBytes: initialFiles.reduce((sum, file) => sum + file.gzipBytes, 0),
    totalBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    initialFiles,
  };
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

/** One line per breached ceiling; empty when the build is within budget. */
export function budgetFailures(measured: Measurement, budget: SizeBudget): string[] {
  const failures: string[] = [];

  if (measured.initialBytes > budget.initial) {
    failures.push(
      `first paint is ${formatBytes(measured.initialBytes)} gzipped, over the ${formatBytes(budget.initial)} budget`,
    );
  }
  if (measured.totalBytes > budget.total) {
    failures.push(
      `the bundle is ${formatBytes(measured.totalBytes)} gzipped in total, over the ${formatBytes(budget.total)} budget`,
    );
  }

  return failures;
}

/** `initial 149.8 kB / 170.0 kB gzipped · total 253.6 kB / 290.0 kB` */
export function summarise(measured: Measurement, budget: SizeBudget): string {
  const initial = `${formatBytes(measured.initialBytes)} / ${formatBytes(budget.initial)}`;
  const total = `${formatBytes(measured.totalBytes)} / ${formatBytes(budget.total)}`;
  return `initial ${initial} gzipped · total ${total}`;
}

/**
 * Fails the build when the bundle outgrows its budget.
 *
 * A warning would be read once and then not again, so this throws: the next
 * dependency that doubles the first paint stops a pull request instead of
 * being noticed a year later. Raising the numbers is allowed — it is meant to
 * be a decision somebody makes in a diff, not a drift nobody sees.
 */
export function sizeBudget(budget: SizeBudget): Plugin {
  return {
    name: 'invintelx:size-budget',
    apply: 'build',

    generateBundle(_options, bundle) {
      const assets: EmittedAsset[] = [];

      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') {
          assets.push({
            fileName: file.fileName,
            gzipBytes: gzipSync(file.code).byteLength,
            isEntry: file.isEntry,
            staticImports: file.imports,
            css: [...(file.viteMetadata?.importedCss ?? [])],
          });
        } else if (file.fileName.endsWith('.css')) {
          assets.push({
            fileName: file.fileName,
            gzipBytes: gzipSync(file.source).byteLength,
            isEntry: false,
            staticImports: [],
            css: [],
          });
        }
        // Fonts and images are not in the budget: they are cached separately
        // and none of them block the first render.
      }

      const measured = measureBundle(assets);
      const failures = budgetFailures(measured, budget);

      if (failures.length === 0) {
        this.info(`size budget ok — ${summarise(measured, budget)}`);
        return;
      }

      const worst = measured.initialFiles
        .slice(0, 5)
        .map((file) => `  ${file.fileName}  ${formatBytes(file.gzipBytes)}`);

      this.error(
        [
          'Bundle over budget.',
          ...failures.map((failure) => `  - ${failure}`),
          '',
          'Largest files in the first paint:',
          ...worst,
          '',
          'Either split the new weight behind a dynamic import, or raise the',
          'budget in apps/web/vite.config.ts and say why in the pull request.',
        ].join('\n'),
      );
    },
  };
}
