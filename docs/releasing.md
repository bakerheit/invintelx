# Releasing InvIntelX

A release is a semver tag cut from `main`, a dated section in
[CHANGELOG.md](../CHANGELOG.md), and a container image published for that tag.
The three go together: a tag with no changelog entry is a version nobody can
decide about, and a changelog entry with no tag is a promise with nothing behind
it.

## What a version number means here

Semver, read from the point of view of somebody running their own instance
rather than somebody importing a library. The public surface of InvIntelX is
everything an operator or a client depends on:

| Surface | Example of a change |
| ------- | ------------------- |
| Environment variables | a new required variable, a changed default, one removed |
| Stored data | a collection reshaped, a field's meaning changed |
| HTTP API | a response field removed, a request field made required |
| Runtime requirements | the minimum Node or MongoDB version going up |
| Default behaviour | something that used to be permitted now refused |

- **MAJOR** — an existing deployment needs a human to do something before or
  after upgrading. Editing `.env`, running a command, changing a reverse proxy.
  If the upgrade is not "pull the tag and restart", it is major.
- **MINOR** — new capability, and an existing deployment upgrades untouched.
  Migrations that run automatically and need no decision belong here.
- **PATCH** — fixes only. No new configuration, no new data shape.

Pre-`1.0.0` this is still the rule. `0.x` is not a licence to break things
quietly; it means the API is still young, not that the changelog can lie.

A pre-release is `v1.2.3-rc.1`. It publishes only its exact image tag — never
`:latest`, `:1` or `:1.2` — so nobody ends up on a release candidate by pulling
loosely.

## What goes in the changelog

Write for somebody who has an instance running and is deciding whether to touch
it. Two subsections are mandatory in every released section, `_None._` included:

- **Breaking** — what stops working and what they must change. Name the variable,
  the field, the endpoint.
- **Migrations** — what runs against their database on first boot. This is the
  one that cannot be undone by pulling the old tag back, so say what it touches
  and whether it is reversible.

Then the ordinary `Added` / `Changed` / `Fixed` / `Removed` / `Security`
sections, as much or as little as the release warrants.

Changes accumulate under `## [Unreleased]` as they are merged — adding your
entry there is part of the pull request, not a chore for whoever releases next.

## Cutting a release

1. **Pick the version** using the rules above. Look at what is under
   `## [Unreleased]` and let that decide, rather than the other way around.

2. **Set the version** in all four `package.json` files — the root,
   `apps/api`, `apps/web` and `packages/shared`. They move in lockstep because
   `apps/api` is what reports the running version at `/api/health`, and a
   release that only bumped the root would report the previous one.

3. **Close the changelog section.** Rename `## [Unreleased]` to
   `## [1.2.3] - YYYY-MM-DD`, read it as the person receiving it, and add a new
   empty `## [Unreleased]` above it with `### Breaking` and `### Migrations`
   set to `_None._`.

4. **Check it before you tag:**

   ```bash
   pnpm release:check v1.2.3
   ```

   This is the same command the release workflow runs. It fails if the version
   in any `package.json` disagrees with the tag, if the changelog has no dated
   section for it, or if that section never says whether anything breaks or
   migrates. On success it prints the notes that will be published and the image
   tags that will be pushed.

5. **Merge to `main`** through the normal review, then tag the merge commit:

   ```bash
   git checkout main && git pull
   git tag -a v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   ```

   Tags are cut from `main` and nowhere else. The workflow verifies that the
   tagged commit is an ancestor of `origin/main` and refuses the release if it
   is not, so a tag on a branch that was never merged cannot become a release.

## What the workflow does

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on any
`v*` tag, in this order — each step gates the next, so a release either happens
completely or does not happen:

1. **check** — the tag parses as semver, the tagged commit is on `main`, the
   package versions agree with it, and the changelog section exists, is dated,
   and answers both mandatory questions.
2. **verify** — typecheck, lint, test and build, by calling the CI workflow
   itself rather than a copy of it. A tag that does not build is not a release.
3. **image** — builds and pushes to `ghcr.io/<owner>/invintelx`, tagged with the
   version and, for a real release, the rolling `:1.2`, `:1` and `:latest`.
4. **publish** — creates the GitHub release using the changelog section
   verbatim as its notes, marked as a pre-release when the version says so.

Nothing here force-pushes a tag or moves one. A published version is immutable:
if a release is wrong, the fix is the next patch version, not a moved tag.

### What the image contains

[`Dockerfile`](../Dockerfile) builds the workspace and ships only what runs it:
the compiled API, the built web assets, and production dependencies. No pnpm, no
TypeScript, no vite, and a non-root user. It is the only artefact an operator
needs — [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) pulls it and
adds a database.

The image job pushes it unconditionally, so a release that publishes no image is
not a state this repository can be in. Two things worth knowing before you tag:

- **The AGPL §13 source offer is compiled in.** The workflow passes
  `VITE_SOURCE_URL=https://github.com/<this repository>` as a build argument. A
  fork that publishes its own image therefore offers its own source, and one
  that pulls ours and modifies it offers nothing — modifying InvIntelX and
  serving it means rebuilding the image.
- **`.github/workflows/image.yml` is what proves the thing works.** It builds
  the image on every pull request, boots the compose stack, and checks that
  `/api/health` answers `ok` with a real database behind it and that the web app
  is served from the same origin. A Dockerfile that compiles but produces a
  container that cannot boot fails there rather than at a tag.

One thing a supported upgrade path still needs is not here: an upgrade exercised
in CI across a real version boundary. Until that exists, whether skipping
versions is allowed is undecided — and undecided means do not skip.
