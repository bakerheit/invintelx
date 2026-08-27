# Backing up and restoring InvIntelX

The movement ledger is the product's truth. On-hand quantity is a projection derived from it and can
be thrown away and recomputed; the ledger itself can be recomputed from nothing. This page is about
keeping a copy of it and — the part that actually matters — being able to prove a copy is good.

> **Status.** The procedure below is written from the code and the compose stack, and the check at
> the end of it is covered by tests. It has **not yet been executed end to end against a real
> deployment by a person**. Until somebody has done that and said so here, treat this as a
> documented restore rather than a proven one. That is the difference INVX-81 exists to close, and
> the epic's acceptance criterion says the same thing.

## What is worth dumping

| Collection | If you lose it |
| ---------- | -------------- |
| `movements` | **Gone forever.** Nothing derives it. This is the backup. |
| `items`, `locations` | Gone forever. Re-enterable by hand, at a cost you will not enjoy. |
| `users` | Gone forever, and with it every account. |
| `stockLevels` | Recomputable from `movements` — but dump it anyway, see below. |
| `schemaVersion` | Recomputable only by guessing. Restore it or the next boot re-runs migrations against a database that has already had them. |
| `sessions` | Disposable. Losing it signs everybody out; the TTL index deletes them anyway. |
| `setupTokens` | Disposable, and short-lived by design. |
| `rateLimits` | Disposable. Restoring it only re-imposes sign-in windows that have already passed; the TTL index empties it within the hour regardless. |

So: **dump the whole database.** The only collection you could reasonably leave out is `sessions`,
and skipping it buys you nothing but a round of sign-ins.

`stockLevels` is derived, which makes it tempting to exclude. Don't. It costs almost nothing — one
row per item/location pair against a ledger that grows forever — and it is the *evidence*. A restore
that still has the original on-hand figures can be checked against the ledger; a restore without
them can only be rebuilt and hoped about. That check is the last step of this page.

## Taking a consistent snapshot

A movement and its projection are written in **one transaction** — that is why
[`docker-compose.yml`](../docker-compose.yml) runs Mongo as a replica set at all. `mongodump`
without `--oplog` does not honour that. It reads collections one after another, so a movement
written between the two reads lands in one collection of the dump and not the other. The restore
then fails the projection check for a reason that is the backup's fault and looks like the restore's.

`--oplog` records the oplog while the dump runs so `--oplogReplay` can bring every collection to the
same point in time. It needs the oplog, which means a replica set — which InvIntelX requires anyway.
It also **cannot be combined with `--db` or `--collection`**: point-in-time means the whole instance
or nothing.

```bash
docker compose exec -T mongo mongodump \
  --uri="mongodb://localhost:27017/?replicaSet=rs0" \
  --oplog --archive --gzip \
  > invintelx-$(date -u +%Y%m%dT%H%M%SZ).archive.gz
```

`-T` matters: without it Docker allocates a TTY and mangles the binary stream on its way to the file.

If the URI needs credentials, put them in the URI rather than on the command line, where they end up
in shell history and in `docker inspect`.

### If you would rather not dump the whole instance

Stop the writers and the inconsistency has nothing to be inconsistent about:

```bash
# stop however you run the API, then:
docker compose exec -T mongo mongodump \
  --uri="mongodb://localhost:27017/?replicaSet=rs0" \
  --db=invintelx --archive --gzip > invintelx.archive.gz
```

This is a real option for a small instance with a maintenance window. It is not a point-in-time
snapshot — it is a snapshot of a database nobody is writing to, which is the same thing for as long
as that holds. If the API is running, it is neither.

`docker-compose.yml` today starts MongoDB and nothing else, so "stop the writers" means stopping
whatever runs the API on your machine. When the compose stack grows an `api` service (INVX-78) this
becomes `docker compose stop api`.

### Not by copying the volume

The compose stack keeps the data in a named volume, `mongo-data`, mounted at `/data/db`:

```bash
docker volume inspect invintelx_mongo-data --format '{{ .Mountpoint }}'
```

The `invintelx_` prefix is the compose project name, which defaults to the directory the checkout is
in — if yours is called something else, so is the volume.

Knowing where it is mostly matters so you know what *not* to do with it. **Copying that directory
while mongod is running does not produce a backup.** WiredTiger has data in memory and in journal
files that a file copy catches mid-flight, and the result is a database that may mount and may then
be wrong. A volume copy is only sound with the container stopped, or from a filesystem or block-level
snapshot that is atomic across the whole directory. `mongodump` needs neither and is what this page
uses.

The volume is also the thing to be careful with on the way back in. `docker compose down -v` deletes
it. `docker compose down` does not.

## Restoring

Every step below assumes you have the archive and a Mongo to put it into.

**1. Stop the API.** A restore into a database something is writing to produces a mixture of two
databases, and the check at the end will say so without being able to say why.

**2. Have an empty database ready.** `mongorestore` merges into what is already there — it does not
replace it. Restoring over a live database leaves you with the union of the two, silently. Either
start Mongo on a fresh volume, or drop the target database first, or restore into a different
database name (see step 6).

```bash
docker compose up -d mongo    # the healthcheck initiates rs0 on the first pass
```

**3. Restore.**

```bash
docker compose exec -T mongo mongorestore \
  --uri="mongodb://localhost:27017/?replicaSet=rs0" \
  --oplogReplay --archive --gzip \
  < invintelx-20260826T020000Z.archive.gz
```

Drop `--oplogReplay` if the dump was taken without `--oplog` — there is no oplog in the archive for
it to replay.

Do **not** pass `--noIndexRestore`. The indexes are in the dump, and several of them are the
uniqueness guarantees the API relies on rather than performance tuning — `uniq_sku`, `uniq_email`,
`uniq_item_location`. An instance restored without them accepts duplicates the code believes are
impossible. (`ensureIndexes` recreates them at the next boot, but "the next boot" is after however
many writes you made in between.)

**4. Count what came back.** Cheap, and it catches a truncated archive before anything subtler does:

```bash
docker compose exec -T mongo mongosh invintelx --quiet --eval '
  ["movements","items","locations","users","stockLevels"].forEach(c =>
    print(c.padEnd(12), db.getCollection(c).countDocuments({})))'
```

Compare with the source instance if you still have it. Movement counts only ever go up, so a
restored count lower than the last one you recorded means the archive is older than you thought.

**5. Check the projection against the ledger — before starting the API.**

```bash
pnpm db:verify
```

Point `MONGODB_URI` and `MONGODB_DB` at the restored database first. The command reads and writes
nothing: it recomputes every on-hand figure from `movements` and compares it with the `stockLevels`
rows that came out of the archive. Exit code 0 means they agree.

```
Reading invintelx at mongodb://localhost:27017/invintelx?replicaSet=rs0

The projection matches the ledger.
  12480 movements
  96 on-hand figures, every one of them re-derived and identical
```

That is the answer you want, and it is worth being precise about what it proves. The ledger and the
on-hand figures **in the snapshot still agree**, which means the dump was taken consistently and
arrived intact. It does not prove the snapshot is up to date: a dump taken at 02:00 is internally
perfect and missing everything after 02:00, and nothing inside a restored database can tell the
difference. That question is answered by your dump schedule, not by this command.

A disagreement looks like this:

```
The projection does NOT match the ledger — 3 disagreements.
  12480 movements
  ledger implies 96 on-hand figures; the projection holds 95 rows
  1 wrong, 1 missing from the projection, 1 not in the ledger

  location  item                      stored  ledger
  A-01      65f0a1b2c3d4e5f601234567      55      40
  A-02      65f0a1b2c3d4e5f601234568  (none)      20
  B-03      65f0a1b2c3d4e5f601234569       5  (none)
```

Read the three kinds separately, because they mean different things:

- **wrong** — both sides have a figure and they differ.
- **missing** — the ledger has movements for a pair the projection has no row for. The dump caught
  the movement and not the level.
- **not in the ledger** — the projection has a row whose movements are not in the dump. The same tear,
  the other way round.

Any of them on a fresh restore points at the dump, not at the restore. Take it again with `--oplog`,
or with the writers stopped, and restore that. A rebuild would make the numbers agree without making
them right.

**6. Only if you accept the restored ledger as the truth**, recompute on-hand from it:

```bash
pnpm db:rebuild
```

This checks, rebuilds, and checks again. It is safe in the sense that it only rewrites what is
downstream of the ledger — and it destroys the evidence of what the projection said when it arrived,
which is why step 5 comes first and this one is conditional. A disagreement that survives a rebuild
is not a stale projection at all; it is a bug or a writer you did not stop.

**7. Start the API** and confirm it comes up: `/api/health` reports the running version. On boot it
runs outstanding migrations and creates indexes, so watch that log rather than assuming it.

## Testing the backup, which is the only thing that makes it one

An untested backup is a belief. Restore a recent archive into a scratch database on a machine that
is not production, and run the check against it:

```bash
MONGODB_DB=invintelx_restore_test pnpm db:verify
```

`mongorestore --nsFrom='invintelx.*' --nsTo='invintelx_restore_test.*'` puts an archive somewhere
harmless without touching the live database. Do it on a schedule. The failure mode this catches is
the one where the dump has been writing a zero-byte file into a full disk every night for a month.

`pnpm db:verify` is a checkout-level command, run through `tsx`. From a production build it is
`node apps/api/dist/reconcile.js` (and `--rebuild`), which — unlike the API server, see the known
issue in the README — has no runtime dependency on `packages/shared` and so is not affected by the
packaging problem that stops `dist/index.js` starting today.

## Restoring into a different version

Restoring an older archive into a newer build is fine: outstanding migrations run at the next boot,
which is the ordinary upgrade path. The reverse is refused — a database recorded at a higher schema
version than the running build knows about stops the boot rather than writing an old shape into
collections that have moved on. See [docs/migrations.md](migrations.md).

So restore into the version you dumped from, or a newer one, and never into an older one. Which is
also the argument for taking a dump immediately before every upgrade: it is the only way back across
a migration.
