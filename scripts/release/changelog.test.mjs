import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  changelogProblems,
  imageTags,
  isPrerelease,
  parseChangelog,
  releaseNotes,
  versionFromTag,
  versionProblems,
} from './changelog.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const GOOD = `# Changelog

Preamble that belongs to no release.

## [Unreleased]

### Breaking

_None._

### Migrations

_None._

## [1.2.0] - 2026-08-26

### Breaking

- \`SESSION_SECRET\` is now required at boot.

### Migrations

- \`0002-split-locations\` runs on first boot and rewrites every location.

### Added

- Cycle counts.

## [1.1.0] - 2026-08-01

### Breaking

_None._

### Migrations

_None._

### Fixed

- On-hand no longer drifts after a reversal.
`;

describe('parseChangelog', () => {
  it('splits on the version headings and ignores the preamble', () => {
    expect(parseChangelog(GOOD).map((s) => s.version)).toEqual(['Unreleased', '1.2.0', '1.1.0']);
  });

  it('keeps the date off the heading', () => {
    expect(parseChangelog(GOOD)[1].date).toBe('2026-08-26');
    expect(parseChangelog(GOOD)[0].date).toBeNull();
  });

  it('stops a section at the next heading rather than running to the end', () => {
    expect(releaseNotes(GOOD, '1.2.0')).toContain('Cycle counts.');
    expect(releaseNotes(GOOD, '1.2.0')).not.toContain('reversal');
  });
});

describe('changelogProblems', () => {
  it('passes a section that answers both questions', () => {
    expect(changelogProblems(GOOD, '1.2.0')).toEqual([]);
  });

  it('refuses a version the changelog has never heard of', () => {
    const [problem] = changelogProblems(GOOD, '9.9.9');
    expect(problem).toMatch(/no section for 9\.9\.9/);
    expect(problem).toMatch(/Unreleased/);
  });

  it('refuses the Unreleased section itself: a release needs a date', () => {
    expect(changelogProblems(GOOD, 'Unreleased')).toContainEqual(
      expect.stringMatching(/no date/),
    );
  });

  it('refuses a release that never says whether anything breaks', () => {
    const missing = GOOD.replace(
      '### Breaking\n\n- `SESSION_SECRET`',
      '### Changed\n\n- `SESSION_SECRET`',
    );
    expect(changelogProblems(missing, '1.2.0')).toContainEqual(
      expect.stringMatching(/no `### Breaking` subsection/),
    );
  });

  it('refuses a release that never says what migrates', () => {
    const missing = GOOD.replace('### Migrations\n\n- `0002', '### Notes\n\n- `0002');
    expect(changelogProblems(missing, '1.2.0')).toContainEqual(
      expect.stringMatching(/no `### Migrations` subsection/),
    );
  });

  it('refuses a skeleton with the headings but nothing under them', () => {
    const empty = `## [2.0.0] - 2026-09-01\n\n### Breaking\n\n### Migrations\n`;
    expect(changelogProblems(empty, '2.0.0')).toContainEqual(
      expect.stringMatching(/headings and nothing else/),
    );
  });
});

describe('versionFromTag', () => {
  it('strips the v', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3');
    expect(versionFromTag('v1.2.3-rc.1')).toBe('1.2.3-rc.1');
  });

  it('rejects anything that is not a release tag', () => {
    for (const tag of ['v1.2', 'v1.2.3.4', 'release-1.2.3', 'v01.2.3', 'vlatest']) {
      expect(() => versionFromTag(tag)).toThrow(/not a release tag/);
    }
  });
});

describe('imageTags', () => {
  it('moves the rolling tags for a real release', () => {
    expect(imageTags('bakerheit/InvIntelX', '1.2.3')).toEqual([
      'ghcr.io/bakerheit/invintelx:1.2.3',
      'ghcr.io/bakerheit/invintelx:1.2',
      'ghcr.io/bakerheit/invintelx:1',
      'ghcr.io/bakerheit/invintelx:latest',
    ]);
  });

  it('moves none of them for a pre-release, so :latest cannot become an rc', () => {
    expect(imageTags('bakerheit/invintelx', '1.2.3-rc.1')).toEqual([
      'ghcr.io/bakerheit/invintelx:1.2.3-rc.1',
    ]);
    expect(isPrerelease('1.2.3-rc.1')).toBe(true);
    expect(isPrerelease('1.2.3')).toBe(false);
  });
});

describe('versionProblems', () => {
  it('names every package that did not get bumped', () => {
    expect(
      versionProblems({ 'package.json': '1.2.3', 'apps/api/package.json': '1.2.2' }, '1.2.3'),
    ).toEqual(['apps/api/package.json says 1.2.2, the tag says 1.2.3.']);
  });
});

describe('this repository', () => {
  const changelog = readFileSync(resolve(repoRoot, 'CHANGELOG.md'), 'utf8');

  it('has a CHANGELOG.md with an Unreleased section to accumulate into', () => {
    expect(parseChangelog(changelog).map((s) => s.version)).toContain('Unreleased');
  });

  it('keeps every package.json on the version the root declares', () => {
    const read = (path) => JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')).version;
    const root = read('package.json');
    expect(
      versionProblems(
        {
          'apps/api/package.json': read('apps/api/package.json'),
          'apps/web/package.json': read('apps/web/package.json'),
          'packages/shared/package.json': read('packages/shared/package.json'),
        },
        root,
      ),
    ).toEqual([]);
  });
});
