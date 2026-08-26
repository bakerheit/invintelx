#!/usr/bin/env node
/*
 * Everything that has to be true before a tag becomes a release, in one place
 * a person can run before they tag:
 *
 *     pnpm release:check v0.2.0
 *
 * The release workflow runs the same command, so a tag that would have been
 * rejected in CI is rejected on the laptop first. Thin on purpose - the rules
 * live in changelog.mjs, which is unit-tested.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changelogProblems,
  imageTags,
  isPrerelease,
  releaseNotes,
  versionFromTag,
  versionProblems,
} from './changelog.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every package.json that carries the product version. */
const VERSIONED = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
];

const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  console.error('Usage: node scripts/release/check-release.mjs v1.2.3');
  process.exit(2);
}

let version;
try {
  version = versionFromTag(tag);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

const declared = Object.fromEntries(
  VERSIONED.map((path) => [path, JSON.parse(read(path)).version]),
);

const problems = [
  ...versionProblems(declared, version),
  ...changelogProblems(read('CHANGELOG.md'), version),
];

if (problems.length > 0) {
  console.error(`✗ ${tag} is not ready to release:\n`);
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('\nSee docs/releasing.md.');
  process.exit(1);
}

const notes = releaseNotes(read('CHANGELOG.md'), version);
const prerelease = isPrerelease(version);
const tags = imageTags(process.env.GITHUB_REPOSITORY ?? 'bakerheit/invintelx', version);

console.log(`✓ ${tag} is ready to release.`);
console.log(`  version:     ${version}${prerelease ? ' (pre-release)' : ''}`);
console.log(`  image tags:  ${tags.join(', ')}`);
console.log(`\n${notes}\n`);

// In CI: hand the workflow the notes it should publish and the tags it should
// push, so nothing downstream re-derives them and gets a different answer.
if (process.env.GITHUB_OUTPUT) {
  const notesFile = join(process.env.RUNNER_TEMP ?? repoRoot, 'release-notes.md');
  writeFileSync(notesFile, `${notes}\n`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `version=${version}`,
      `is-prerelease=${prerelease}`,
      `notes-file=${notesFile}`,
      `image-tags<<TAGS`,
      ...tags,
      'TAGS',
      '',
    ].join('\n'),
  );
}
