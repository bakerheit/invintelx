# Upgrading InvIntelX

For somebody who has an instance with real data in it and wants a newer version of the code without
losing any of it.

## May I skip versions?

**Yes, within a major version. No, across one.**

- `0.1.0` → `0.6.2` in one step: **supported.** You do not have to stop at `0.2.0`, `0.3.0` and
  everything in between.
- `1.9.4` → `2.0.0` in one step: **not supported.** Upgrade to the last release of `1.x` first, then
  to `2.0.0`. If you are three majors behind, that is three stops.
- Going *backwards*, at any distance: **not supported, and the API will not let you.** See
  [Downgrading](#downgrading).

Pre-`1.0.0` this project treats a minor bump the way semver treats a major, so read `0.x` → `0.y` as
the major rule: **stop at the last patch of each minor on the way up.** `0.3.1` → `0.3.4` is one
step; `0.3.4` → `0.5.0` is two, via the last `0.4.x`. This gets simpler at `1.0.0` and the changelog
will say so when it does.

### Why that is the rule

Two different reasons, and they are worth telling apart because only one of them is about the
database.

**Skipping minors and patches is safe because migrations are numbered, not diffed.** Your database
records the highest migration it has run. On boot, the new build runs every migration above that
number, in order, whether that is one of them or eleven. Nothing consults the version you came from,
so there is no arrangement of skipped releases that leaves a migration unrun.

That is the design. What makes it a claim rather than a hope is
`apps/api/src/migrations/upgrade.test.ts`: it keeps a frozen snapshot of the database as *every*
released version left it, and upgrades each one straight to the current build in a single hop —
never through the versions in between, because that is not what it is promising. It then checks that
nothing was lost and that every on-hand figure still reconciles against the movement ledger it is
derived from. It runs on every pull request, and again as its own gate on every release.

**Not skipping a major is not about migrations at all.** A major version means, in this project's
words, that *an existing deployment needs a human to do something* — edit `.env`, run a command,
change a reverse proxy. Those instructions are written per release, in that release's changelog
section. Skipping a major skips its instructions, and no amount of automatic migration covers a step
whose whole nature is that it was not automatic.

So the rule reduces to: the machine will replay whatever it has to; you still have to read every
changelog section between where you are and where you are going, and do what the major ones tell
you.

## Doing it

1. **Read the changelog** for every section between your version and the target — not just the
   newest. **Breaking** and **Migrations** lead every section for exactly this reason.

2. **Back up, and check the backup.** A migration is the one change to your data that pulling the
   old tag back does not undo. See [backup-and-restore.md](backup-and-restore.md); `pnpm db:verify`
   is what turns "the dump finished" into "the dump is consistent".

3. **Stop the old version**, or accept that a rolling deploy means old and new run together for a
   moment. That is handled — the first process to boot takes a lock and migrates, the rest wait and
   find the work done — but the old processes are serving the old shape while it happens.

4. **Deploy the new tag and start it.**

5. **Watch the boot log.** It names each migration as it applies it and prints the version the
   database ended on. Nothing serves a request until that is finished.

6. **Check the ledger reconciles**, which is the same check the upgrade test makes and the only one
   that speaks to your own data rather than to ours:

   ```bash
   pnpm db:verify
   ```

   Exits zero when every on-hand figure agrees with the movements it is derived from.

## When the boot stops

Migrations run before the server listens, so a database the code cannot safely use produces a
process that exits rather than one that serves wrong answers. The message says which versions
disagree and what to do. [migrations.md](migrations.md) is the page for reading one.

A migration that fails records nothing: the database stays at the version it was at, and the next
boot retries from the start. Fix the cause, or restore the backup — do not edit the version document
to get past it.

## Downgrading

Not supported, and enforced rather than requested. A database at a schema version higher than the
running build understands stops the boot. Old code against a new shape writes the old shape back
into collections that have moved on, and it does it quietly.

If a release turns out to be wrong, the ways forward are the next patch version, or restoring the
backup you took at step 2.

## What is not proven

Honesty about the shape of the guarantee, so nobody reads more into it than is there:

- The upgrade test exercises **the database**. It restores a recorded shape, runs the real migration
  runner and the real index creation against it, and checks the data. It does not stand up the old
  release's *process* and talk HTTP to it — there is no published container image to stand up yet.
- It therefore proves that your data survives the new code. It does not prove that the old release
  and the new one can serve traffic side by side during a rolling deploy.
- Coverage is exactly the fixtures in `apps/api/src/migrations/fixtures/`, one per release. Cutting
  a release adds its own, and the release workflow fails if one is missing — so the set cannot
  quietly stop keeping up.
