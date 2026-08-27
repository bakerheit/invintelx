# Schema migrations

InvIntelX records what shape its database is in, and refuses to run against a shape it does not
understand. This page is for two people: whoever is writing a migration, and whoever is reading a
boot log that stopped.

## What happens at boot

`apps/api/src/index.ts` calls `runMigrations()` before `ensureIndexes()` and before the server
listens. Nothing serves a request until the code and the database agree.

The state lives in one document in the `schemaVersion` collection, `_id: "schema"`:

```js
{
  _id: "schema",
  version: 3,                    // highest migration applied
  applied: [                     // kept forever
    { version: 1, name: "baseline", appliedAt: ISODate(...), durationMs: 1 },
    ...
  ],
  updatedAt: ISODate(...),
  lock: null                     // or the process currently migrating
}
```

A database with no such document is at version 0 and every migration is outstanding.

Migrations run in version order, one at a time, and each is recorded only after it returns.
A migration that throws leaves the version where it was, so **every migration has to be safe to run
again from the start** — it will be, on the next boot.

## Two API processes booting at once

The `lock` field in the version document is what makes "runs once" true rather than merely likely.
One process takes it; the others wait, then find the work already done. The holder refreshes a
heartbeat while it works, so a lock left behind by a process that was killed is taken over after
thirty seconds rather than blocking every future boot.

If a boot reports `Timed out ... waiting for another process`, something is holding the lock and
still claiming to be alive. Stop every instance, look at `db.schemaVersion.findOne()`, and only then
decide what to do about the lock.

## Adding a migration

1. Add `apps/api/src/migrations/mNNN-what-it-does.ts` exporting a `Migration`.
2. Append it to `MIGRATIONS` in `apps/api/src/migrations/list.ts`. Append — never insert, renumber
   or delete. Those numbers are recorded in other people's databases, and changing one silently
   skips work on every instance that already ran it.
3. Say what it does in the changelog for the release that ships it.

```ts
export const m002AddSupplierRef: Migration = {
  version: 2,
  name: 'add-supplier-ref',
  up: async ({ db, log }) => {
    const result = await db
      .collection('items')
      .updateMany({ supplierRef: { $exists: false } }, { $set: { supplierRef: '' } });
    log(`backfilled ${result.modifiedCount} items`);
  },
};
```

Use the raw `db` handed to the migration, not the typed collection helpers in `db.ts`. Those
describe the shape the *current* code expects; a migration by definition runs against an older one,
so reading through them is reading a lie.

`assertMigrationsAreWellFormed` runs when the list module is imported, so a renumbered or
duplicated migration fails on the machine that wrote it rather than halfway through a stranger's
upgrade.

### What runs your migration before anybody else does

`apps/api/src/migrations/upgrade.test.ts` keeps a frozen snapshot of the database as every released
version left it, and puts each one through the full list — yours included — the moment you append
it. It then checks that no document went missing, that no movement was altered unless the migration
declared a `rewrite`, and that every on-hand figure still reconciles against the ledger.

So a migration that loses a row fails on a pull request rather than on somebody's warehouse. What it
cannot tell you is whether the *change* was the right one; that is what the changelog entry and a
reviewer are for.

If your migration makes an old fixture fail, the fixture is not the thing to fix. It is a record of
what somebody's database actually contains, and it is exactly the input your migration exists to
handle. See [the fixtures README](../apps/api/src/migrations/fixtures/README.md).

## Migrations that touch the movement ledger

`movements` is append-only and it is the product's truth — every on-hand figure is derived from it,
and a self-hoster's only copy of their history is the one you are about to run code against. A
migration that reads or writes it must say so:

```ts
ledger: 'additive'   // enforced
ledger: 'rewrite'    // declared, not enforced
```

`'additive'` is checked. The runner counts `movements` before and after, and if the count went down
the migration is **not recorded**, the boot fails, and the message says how many rows went missing.

`'rewrite'` buys a loud log line and nothing else — no assertion can tell a correct rewrite from a
wrong one. Anything declaring it needs a reverse migration written alongside it and a changelog
entry that spells out what it does, because there is no undo for the person running it.

Leave `ledger` off entirely for a migration that does not go near `movements`.

## Downgrading

Not supported, and the API enforces it: a database at a version higher than the running build knows
about stops the boot with a message naming both versions. Old code against a new shape writes the
old shape back into collections that have moved on, which corrupts quietly. Deploy the newer release
again, or restore the backup taken before the upgrade.

Going the other way — including several versions at once — is [upgrading.md](upgrading.md).
