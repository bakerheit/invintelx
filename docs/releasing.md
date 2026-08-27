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

4. **Record the shape this release leaves behind.** Add
   `apps/api/src/migrations/fixtures/v1.2.3.json`: a small database exactly as this version stores
   it, including whatever its own migrations did. That file is what the *next* release's upgrade is
   proven against, and it is frozen the moment this tag exists —
   [the fixtures README](../apps/api/src/migrations/fixtures/README.md) says why editing one later
   is worse than useless. The release workflow refuses a version with no fixture, so this is not a
   step that can be skipped and remembered next time.

5. **Check it before you tag:**

   ```bash
   pnpm release:check v1.2.3
   ```

   This is the same command the release workflow runs. It fails if the version
   in any `package.json` disagrees with the tag, if the changelog has no dated
   section for it, or if that section never says whether anything breaks or
   migrates. On success it prints the notes that will be published and the image
   tags that will be pushed.

6. **Merge to `main`** through the normal review, then tag the merge commit:

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
3. **upgrade** — restores the database as every previously released version left
   it, runs this tag's migrations over each one, and checks nothing was lost and
   that on-hand still reconciles against the ledger. Also fails when this
   release arrived without a fixture of its own. `verify` runs the same
   assertions inside `pnpm test`; this repeats them as a named gate, because a
   broken upgrade is the one failure that must not arrive as a line buried in a
   test log. See [upgrading.md](upgrading.md).
4. **image** — builds and pushes to `ghcr.io/<owner>/invintelx`, tagged with the
   version and, for a real release, the rolling `:1.2`, `:1` and `:latest`.
5. **publish** — creates the GitHub release using the changelog section
   verbatim as its notes, marked as a pre-release when the version says so.

Nothing here force-pushes a tag or moves one. A published version is immutable:
if a release is wrong, the fix is the next patch version, not a moved tag.

### The image step is not finished yet

There is no `Dockerfile` in this repository yet. Until there is, the image job
does not fail the release — it writes a warning into the run summary saying no
image was published, and the release is otherwise real. When the Dockerfile
lands the job starts publishing with no change to this workflow.

So today a release means "a tag, a changelog entry, and a GitHub release you can
build from source". It does not yet mean "an image you can pull", and the
changelog's *Known limitations* says so.

The other two things a supported upgrade path needs are here. Schema migrations
record what shape a database is in and refuse to run against one they do not
understand ([migrations.md](migrations.md)), and the upgrade itself is exercised
on every release rather than described — every released shape, restored and put
through this tag's migrations, with the data checked afterwards.

Which settles the question that used to sit here: **skipping versions is
allowed within a major and not across one.** [upgrading.md](upgrading.md) is
that answer in full, and it is the page to send somebody who asks how to move
between two versions.
