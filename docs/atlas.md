# The Atlas cluster behind invintelx.org

What the hosted instance's database is, how it is configured, and why each of those choices is the
one it is. Self-hosting does not need this page — [the README](../README.md) covers running your own
Mongo, and [docs/backup-and-restore.md](backup-and-restore.md) covers dumping it.

> **Status.** Nothing described here has been provisioned yet. This is the page whoever creates the
> cluster works from, and the page they correct afterwards — the cluster name, the region and the
> retention numbers are decisions this page asks for rather than records. Until somebody has done it
> and said so here, read it as a plan.

## What the app requires of a database

Two things, and they are both already true of a default Atlas cluster:

- **A replica set.** A movement and the on-hand figure it changes are written in one transaction, and
  Mongo has no transactions on a standalone `mongod`. That is why `docker-compose.yml` bothers to run
  a single-node replica set locally. Every Atlas cluster is a replica set, so this needs no thought
  — it just must not be traded away for a standalone anything.
- **Room to create its own indexes.** `ensureIndexes()` in `apps/api/src/db.ts` runs at every boot
  and creates the uniqueness guarantees the routes rely on. The application user has to be allowed
  to do that.

Everything below is about the parts Atlas does not get right on its own.

## One cluster, two databases

| Environment | Database | Set by |
| ----------- | -------- | ------ |
| Production  | `invintelx` | `MONGODB_DB=invintelx` |
| Staging     | `invintelx_staging` | `MONGODB_DB=invintelx_staging` |

One cluster because two is twice the bill for an instance this size. The honest version of isolation
is separate clusters, and this is not it — it is the compromise, so the thing that would make the
compromise dangerous is closed deliberately:

**The database name is the only separation, so it is not allowed to be implicit.** Both environments
run the same build against the same cluster with the same connection string shape. Before this,
`MONGODB_DB` had a default of `invintelx` — a staging deploy that simply forgot the variable would
have come up pointing at production's collections and started writing to them, with nothing in the
log to suggest anything was wrong. `apps/api/src/env.ts` now refuses to start at all when
`NODE_ENV=production` and `MONGODB_DB` is unset. Outside production the default still applies, where
there is only one database and no confusion to have.

Note also that the database named in a connection string's path is **ignored**. Atlas's Connect
dialog will happily give you `.../invintelx?retryWrites=true`; the app passes `MONGODB_DB` to
`client.db()` and never looks at the path. Do not use the path to tell the two environments apart.

## The application users

Two of them, one per environment, each with exactly one role:

| User | Role | Scope |
| ---- | ---- | ----- |
| `invintelx_app_prod` | `readWrite` | database `invintelx` only |
| `invintelx_app_staging` | `readWrite` | database `invintelx_staging` only |

Two users rather than one is what makes the shared cluster defensible: production's credentials
cannot read staging and staging's cannot touch production, so leaking the staging secret — the one
that will end up in more places — does not reach the data that matters.

`readWrite` on the one database is the whole grant. **Not** `atlasAdmin`, **not**
`readWriteAnyDatabase`, and not `dbAdmin` on top. `readWrite` already covers everything the app does:
the collections, the indexes `ensureIndexes()` creates, the `schemaVersion` lock document the
migration runner contends on, and multi-document transactions.

What it deliberately cannot do is read `local.oplog.rs`, which means the application user **cannot
take the `--oplog` dump** [docs/backup-and-restore.md](backup-and-restore.md) describes. That is the
intended outcome, not a gap: on Atlas, snapshots are Atlas's job (below), and the credential the API
carries around should not be one that can walk off with the whole cluster.

People get their own logins with their own roles. Nobody uses the application user to look at data.

## The IP allowlist

**Never `0.0.0.0/0`.** Atlas offers it in the setup wizard, next to a button that fills in your
current address, and it is the single most common reason one of these ends up readable from the
internet. The password is then the only thing in the way, and the password is in an environment
variable in a deployment platform.

What belongs in it depends on where the API runs, which is INVX-34's decision and not yet made:

- If the host gives the API **static egress addresses**, those addresses, and nothing else.
- If it does not, an Atlas **private endpoint** or VPC peering, which is the answer that does not
  depend on egress addresses staying still.
- Failing both, the host's documented egress ranges — worth knowing that this allowlists every other
  tenant of that host as well, so it is the weakest of the three and should be written down here as a
  known compromise if it is what gets chosen.

Two things that do **not** need an entry:

- **CI.** `pnpm test` boots a real `mongod` locally through `mongodb-memory-server` rather than
  talking to a remote database, so no GitHub Actions runner ever connects to Atlas. Nothing about
  the test suite justifies opening the allowlist to a shared runner pool.
- **A laptop, permanently.** Restoring and checking a backup needs an address in the list; it needs
  it for an afternoon. Atlas entries take an expiry — use it.

## Backups

Turn on Atlas cloud backup for the cluster, which is a per-cluster setting and so covers both
databases whether or not staging deserves it.

- **Production:** continuous backup with point-in-time restore if the tier offers it, scheduled
  snapshots if it does not.
- **Retention** is a decision nobody has made yet. The failure this is really insuring against is
  corruption discovered late — a bad restore, a bad migration, someone's mistake noticed a week
  later — so retention wants to be weeks rather than days. Daily snapshots kept a week plus weekly
  snapshots kept a month is a reasonable starting proposal. **Whoever provisions this should write
  the numbers actually chosen into this table.**
- **Staging** does not need its own retention policy and paying for one is reflex, not reasoning. It
  is restorable from a production snapshot when it is worth restoring at all.

Atlas snapshots do not have the failure mode `mongodump --oplog` exists to avoid: they are taken
underneath the database rather than by reading one collection after another, so they do not tear a
movement away from the on-hand figure written in the same transaction.

That is a reason to expect the check to pass, not a reason to skip it:

```bash
MONGODB_URI='mongodb+srv://…restore target…' MONGODB_DB=invintelx_restore_test pnpm db:verify
```

`pnpm db:verify` recomputes every on-hand figure from the movement ledger and compares it against the
figures that came out of the snapshot. It writes nothing and exits non-zero on a disagreement. An
untested backup is a belief; this is the step that turns it into evidence, and
[docs/backup-and-restore.md](backup-and-restore.md) walks the whole restore that ends in it.

Restoring an Atlas snapshot gives you a cluster, not a directory, so the restore target is a scratch
cluster or a scratch database name — never the production database, which `mongorestore` would merge
into rather than replace.

## What the API needs in its environment

`apps/api/src/env.ts` is the definition of which variables are required and what shape each has to
be. It is the file to read, and the file to change when that answer changes; this section is an
example, not a second source of truth. A variable it rejects stops the boot with every problem listed
at once, so a misconfigured deploy fails at start-up rather than on whichever request first touches
the thing that was wrong.

Production:

```
NODE_ENV=production
MONGODB_URI=mongodb+srv://invintelx_app_prod:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=invintelx
SESSION_SECRET=<32+ random chars, this environment's own>
WEB_ORIGIN=https://invintelx.org
FIRST_ADMIN_SETUP=open
```

Staging is the same file with its own user, its own database, its own origin — and its own
`SESSION_SECRET`. Sharing one across environments would make a session cookie minted by staging
valid in production, which is a staging bug becoming a production account.

`FIRST_ADMIN_SETUP=open` on invintelx.org is deliberate and is explained in `.env.example` and the
README: it is what a public sign-up product wants, and it is wrong everywhere else. Staging should
stay on the default `token`.

`retryWrites=true&w=majority` is what Atlas's own connection string carries and is worth keeping:
majority write concern is what makes an acknowledged movement survive a primary election.

## Secrets

The connection string contains the password, so the string is a secret in full — not a URL with a
secret in it, and not something to paste into a ticket, a commit or a log. `apps/api/src/reconcile.ts`
already redacts credentials before printing the URI, which is the standard the rest of the code
should hold to.

Where they live is the host's secret store, and which host is INVX-34's decision. What is settled is
where they do **not** live: `.env` is gitignored, `.env.example` carries placeholders only, and
`.github/workflows/gitleaks.yml` scans every push.

Rotating one is a three-step move with no downtime: add a second Atlas user, redeploy with its
credentials, delete the first. Worth doing once deliberately so it is a known procedure before it is
an incident.

## Provisioning checklist

1. Create the cluster. Record its name, tier and region here — the region should match wherever
   INVX-34 lands the API, because every request pays that round trip.
2. Create `invintelx` and `invintelx_staging`. Empty is fine; the API creates its own collections and
   indexes on first boot.
3. Create the two application users, each `readWrite`-scoped to one database.
4. Set the IP allowlist. Confirm `0.0.0.0/0` is not in it.
5. Turn on cloud backup and set retention. Record the numbers in the table above.
6. Put the two connection strings in the host's secret store.
7. Boot the API against staging and watch the log: it runs migrations, creates indexes and prints a
   setup token. `/api/health` reports the running version.
8. Take a snapshot, restore it into a scratch database, and run `pnpm db:verify` against it. Until
   that has been done the backups are configured, not proven.
9. Come back and delete the status note at the top of this page.
