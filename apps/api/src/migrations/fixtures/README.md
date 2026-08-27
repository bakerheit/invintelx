# Release fixtures

One file per released version: a small database in exactly the shape that release left behind.

`upgrade.test.ts` restores each of these, runs the boot sequence this build would run —
`runMigrations()` then `ensureIndexes()` — and asserts the data came out the other side. That is
what "the upgrade path is proven" means here, and it is only worth anything because these files do
not change when the code does.

## The rule

**A fixture is frozen the moment its release is tagged.** It is a record of what somebody else's
database looks like right now, not a description of what this build expects. Editing one to make a
test pass is editing the past so the present agrees with it: the test still goes green and the
upgrade is still broken on the machine that matters.

If a migration has to reshape what is in here, that is what the migration is for. Write it, let it
run against the untouched fixture, and assert the result.

The only edits a released fixture ever takes are corrections to a *mistake in the record* — the
fixture said something the release never actually wrote. Say so in the commit message.

## Adding one

Cutting a release adds a fixture for it, in the same pull request that closes the changelog section.
See `docs/releasing.md`.

1. Copy the newest fixture to `vX.Y.Z.json`.
2. Set `release` to the version and `schemaVersion` to what a database on that release records.
3. Adjust the documents to whatever that release actually stores, including anything its own
   migrations added.
4. Run `pnpm test:upgrade`. The suite checks the fixture is internally consistent — its on-hand
   figures must already agree with its own ledger — before it upgrades anything, so a snapshot
   written wrong fails as a bad fixture rather than as a bad migration.

## Format

Extended JSON, parsed with the driver's own `EJSON`: `{"$oid": "..."}` is an ObjectId and
`{"$date": "..."}` a Date. Documents are inserted raw rather than through the typed collection
helpers in `db.ts` — those describe the shape the *current* code expects, which is the one thing a
fixture must not be checked against.

```jsonc
{
  "release": "0.1.0",
  "schemaVersion": 1,        // what that release's schemaVersion document records
  "note": "...",
  "collections": {
    "schemaVersion": [ /* the version document as that release wrote it */ ],
    "items": [ /* ... */ ]
  }
}
```

Keep them small. Four bins and nine movements exercise a transfer pair, a reversal and an
adjustment, which is what the ledger assertions are about; ten thousand rows would exercise the same
code and take a minute doing it.

## Databases older than migrations

There is no fixture for "before the migration mechanism existed". The suite derives that case from
the oldest fixture by dropping its `schemaVersion` document, which is precisely what such a database
is: the same shape, with nothing recorded about it.
