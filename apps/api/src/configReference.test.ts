import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema } from './envSchema.js';
import {
  CONFIG_REFERENCE_PATH,
  extractGenerated,
  renderConfigReference,
  spliceGenerated,
} from './configReference.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('the configuration reference', () => {
  /*
   * The whole reason the reference is generated. A variable added to the schema
   * without a word written about it fails here, and so does a page edited by
   * hand inside the generated block.
   */
  it('matches docs/configuration.md as committed', () => {
    const page = readFileSync(CONFIG_REFERENCE_PATH, 'utf8');
    expect(extractGenerated(page)).toBe(renderConfigReference());
  });

  it('documents every variable the API reads, and no others', () => {
    const documented = [...renderConfigReference().matchAll(/^### `([A-Z0-9_]+)`$/gm)].map(
      (m) => m[1],
    );
    expect(documented).toEqual(Object.keys(envSchema.shape));
  });

  /*
   * `.env.example` is the file people actually copy, so a variable that exists
   * only in the schema is one they will meet as a boot failure.
   */
  it('leaves nothing out of .env.example', () => {
    const example = readFileSync(resolve(repoRoot, '.env.example'), 'utf8');
    const missing = Object.keys(envSchema.shape).filter(
      (name) => !new RegExp(`^#?\\s*${name}=`, 'm').test(example),
    );
    expect(missing).toEqual([]);
  });

  describe('splicing', () => {
    it('replaces only what lies between the markers', () => {
      const page = readFileSync(CONFIG_REFERENCE_PATH, 'utf8');
      const spliced = spliceGenerated(page, extractGenerated(page));
      expect(spliced).toBe(page);
    });

    it('does not read $-sequences out of the replacement', () => {
      const page = readFileSync(CONFIG_REFERENCE_PATH, 'utf8');
      const block = extractGenerated(page);
      const spliced = spliceGenerated(page, `${block}\n\n$& $\` $'`);
      expect(spliced).toContain("$& $` $'");
    });

    it('refuses a page whose markers have been removed', () => {
      expect(() => spliceGenerated('# Configuration\n\nNo markers here.\n', 'x')).toThrow(
        /no generated block/,
      );
    });
  });
});
