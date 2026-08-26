/*
 * The rules a tag has to satisfy before it becomes a release, kept here as
 * plain functions rather than inline in the workflow so they are unit-tested.
 * A release that half-published because of a typo in a shell one-liner is a
 * bad way to find out the rules were never checked.
 *
 * No dependencies on purpose: the release workflow runs this before it has
 * installed anything.
 */

/** https://semver.org - the official recommended expression, anchored. */
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The heading changes accumulate under until somebody cuts a release. */
export const UNRELEASED = 'Unreleased';

/**
 * Every released section must answer these two, even when the answer is "none".
 * They are the two questions the person deciding whether to upgrade actually
 * has, and the two a changelog assembled from commit subjects never answers.
 */
export const REQUIRED_SUBSECTIONS = ['Breaking', 'Migrations'];

/*
 * `## [1.2.3] - 2026-08-26` and `## [Unreleased]`, with the brackets and the
 * dash both optional so a hand-written heading is not rejected over punctuation.
 */
const HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s*[-–—]\s*(.+?))?\s*$/;

/**
 * Split a changelog into its `##` sections, in file order.
 *
 * @param {string} markdown
 * @returns {{ version: string, date: string | null, body: string }[]}
 */
export function parseChangelog(markdown) {
  const sections = [];
  let current = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { version: heading[1], date: heading[2] ?? null, body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }

  return sections.map((section) => ({
    version: section.version,
    date: section.date,
    body: section.body.join('\n').trim(),
  }));
}

/**
 * The section for one version, or null when the changelog has never heard of it.
 *
 * @param {string} markdown
 * @param {string} version
 */
export function releaseSection(markdown, version) {
  return parseChangelog(markdown).find((section) => section.version === version) ?? null;
}

/** Does the body carry a `### Breaking` (or whichever) subsection? */
function hasSubsection(body, name) {
  return new RegExp(`^###\\s+${name}\\b`, 'im').test(body);
}

/** Anything at all under the headings, so an empty skeleton is not a release. */
function hasProse(body) {
  return body
    .split(/\r?\n/)
    .some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

/**
 * Everything that would make releasing `version` a lie, as sentences a person
 * can act on. An empty list means the tag is good to publish.
 *
 * @param {string} markdown contents of CHANGELOG.md
 * @param {string} version e.g. `1.2.3`
 * @returns {string[]}
 */
export function changelogProblems(markdown, version) {
  const section = releaseSection(markdown, version);

  if (!section) {
    return [
      `CHANGELOG.md has no section for ${version}. Rename the \`## [${UNRELEASED}]\` ` +
        `heading to \`## [${version}] - YYYY-MM-DD\` and commit that before tagging.`,
    ];
  }

  const problems = [];

  if (!section.date) {
    problems.push(
      `The \`## [${version}]\` heading has no date. A released section is dated: ` +
        `\`## [${version}] - YYYY-MM-DD\`.`,
    );
  }

  for (const name of REQUIRED_SUBSECTIONS) {
    if (!hasSubsection(section.body, name)) {
      problems.push(
        `The ${version} section has no \`### ${name}\` subsection. Say so explicitly — ` +
          `\`_None._\` is a perfectly good answer, silence is not.`,
      );
    }
  }

  if (!hasProse(section.body)) {
    problems.push(`The ${version} section is headings and nothing else.`);
  }

  return problems;
}

/**
 * The notes to hand to the GitHub release: the section body, unchanged.
 *
 * @param {string} markdown
 * @param {string} version
 */
export function releaseNotes(markdown, version) {
  const section = releaseSection(markdown, version);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  return section.body;
}

/**
 * `v1.2.3` -> `1.2.3`. Throws on anything that is not a semver release tag,
 * because a tag the workflow cannot parse must not quietly publish `:latest`.
 *
 * @param {string} tag
 */
export function versionFromTag(tag) {
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (!SEMVER.test(version)) {
    throw new Error(
      `\`${tag}\` is not a release tag. Tags are \`v<major>.<minor>.<patch>\`, ` +
        `optionally with a pre-release suffix: \`v1.2.3\`, \`v1.2.3-rc.1\`.`,
    );
  }
  return version;
}

/** A pre-release is anything with a `-suffix`: `1.2.3-rc.1`. */
export function isPrerelease(version) {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`\`${version}\` is not a semver version.`);
  return match[4] !== undefined;
}

/**
 * Image tags for a version. A real release also moves the rolling tags, so
 * `:1`, `:1.2` and `:latest` mean something to someone pinning loosely. A
 * pre-release moves none of them — opting into `v1.2.3-rc.1` must never be
 * something a `:latest` puller can do by accident.
 *
 * @param {string} repository `owner/name`, as GitHub gives it
 * @param {string} version
 * @returns {string[]}
 */
export function imageTags(repository, version) {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`\`${version}\` is not a semver version.`);

  // Registries reject uppercase in a repository name; GitHub owners allow it.
  const image = `ghcr.io/${repository.toLowerCase()}`;
  const tags = [`${image}:${version}`];

  if (match[4] === undefined) {
    tags.push(`${image}:${match[1]}.${match[2]}`, `${image}:${match[1]}`, `${image}:latest`);
  }

  return tags;
}

/**
 * Every package.json in the workspace carries the product version, so the
 * version the API reports at `/api/health` is the version that was tagged.
 * This is what catches a release where only the root got bumped.
 *
 * @param {Record<string, string>} versions path -> version
 * @param {string} expected
 * @returns {string[]}
 */
export function versionProblems(versions, expected) {
  return Object.entries(versions)
    .filter(([, version]) => version !== expected)
    .map(([path, version]) => `${path} says ${version}, the tag says ${expected}.`);
}
