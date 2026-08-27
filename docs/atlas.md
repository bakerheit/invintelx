# The Atlas cluster behind invintelx.org

What the hosted instance's database is, how it is configured, and why each of those choices is the
one it is. Self-hosting does not need this page — [the README](../README.md) covers running your own
Mongo, and [docs/backup-and-restore.md](backup-and-restore.md) covers dumping it.

> **Status.** Nothing described here has been provisioned yet. This is the page whoever creates the
> cluster works from, and the page they correct afterwards — the cluster name, the exact tier and the
> retention numbers are decisions this page asks for rather than records. Until somebody has done it
> and said so here, read it as a plan.
>
> The API's host is no longer an open question: INVX-34 settled it as Fly.io with Cloudflare in
> front. So the region and the allowlist below are answerable rather than deferred, and this page
> names Fly commands where it used to say "the host's secret store". `docs/deploying.md` and
> `fly.toml`, referred to below, arrive with INVX-34 and are not in the tree yet — the two branches
> are independent and neither contains the other.

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

## Region

**The rule is the decision; the city is a detail.** The cluster goes in whichever region the API runs
in, because every request this app serves makes at least one round trip to Mongo and a cross-ocean
one turns a 2ms hop into a 70ms one that no amount of application work gets back. Getting this wrong
is not a tuning problem — it is not fixable without moving a live database.

INVX-34 put the API on Fly with `primary_region = 'lhr'`, and its `fly.toml` says in as many words
that the value is a placeholder waiting on this page. So: **Atlas on AWS `eu-west-2` (London), to
match Fly `lhr`.** London rather than anywhere else only because Fly's file already said London;
nothing here argues for that continent over another, and if the API moves this cluster moves with it.

Two things worth knowing before treating that as settled:

- **The pair has to stay a pair.** Anyone changing either side changes both, or the app is an ocean
  from its data with nothing failing loudly to say so. That is the only part of this section that is
  not negotiable.
- **Fly region codes and Atlas region codes are different vocabularies** — `lhr` is Fly's, `eu-west-2`
  is AWS's as Atlas presents it, and Atlas has its own `EU_WEST_2` spelling in the API. Confirm the
  mapping in the Atlas console at creation time rather than trusting this line; it is written from
  Fly's and AWS's published region lists, not from a console anybody logged in to.

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

What belongs in it depends on where the API runs, and that is now known — Fly, per INVX-34. Which
narrows three options to a shortlist, and not a comfortable one:

- **Static egress addresses**, and nothing else, is the answer if the app has them. A Fly machine's
  outbound traffic is NAT'd through its host by default, so the source address is the host's and not
  the app's. **Check whether the app has a dedicated egress address before assuming it does** — this
  is the one question that decides this section, it is a Fly feature question rather than an Atlas
  one, and it is not answerable from this repo.
- **Atlas private endpoint or VPC peering** does not apply here. Both terminate in a cloud account's
  own network, and a Fly app is not in a VPC you hold. This was the strongest option on the generic
  list and choosing Fly is what took it off.
- **The host's documented egress ranges** is what is left if the first is unavailable, and it is
  weak in a specific way: it allowlists every other tenant sharing those addresses, so the password
  goes back to being the only thing in the way. If this is what gets chosen it is a **known
  compromise and must be written into this page as one**, with the ranges and the date, rather than
  entered in the console and forgotten.

If it comes to the third, the mitigation is elsewhere and is already half-built: the two scoped users
below mean a leaked staging credential reaches staging only, and rotation is three steps with no
downtime. Neither makes an open allowlist fine; both make it survivable.

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

### How each of those reaches the container, and the one that will bite

Those six values arrive by two different routes, and the split is not cosmetic. INVX-34's `fly.toml`
carries an `[env]` block — plain text, in the repo, reviewed like code — which sets `NODE_ENV`,
`PORT`, `WEB_ORIGIN` and `FIRST_ADMIN_SETUP`. It does not set `MONGODB_URI` or `MONGODB_DB`, and
**`MONGODB_URI` must never be added to it**: the string has the cluster password inside it, so
committing it publishes the database. Both come from Fly's secret store instead:

```bash
fly secrets set --app invintelx \
  MONGODB_URI='mongodb+srv://invintelx_app_prod:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority' \
  MONGODB_DB=invintelx \
  SESSION_SECRET="$(openssl rand -base64 32)"
```

`MONGODB_DB` is not itself a secret — `invintelx` is not a password — but it belongs with the URI
because the two are one decision. Splitting them across a committed file and a secret store is how
they drift apart, and the pair drifting apart is exactly what points production at the wrong data.

**This is the trap, and it is live right now.** `fly.toml` sets `NODE_ENV=production`, and this
change makes `MONGODB_DB` mandatory under that. So an app deployed before those secrets are set does
not come up degraded — it exits at boot, the health check never passes, and the release rolls back.
That is the schema working as designed: the alternative was booting quietly against the default
database, which on a production cluster is somebody else's data. But it means **the first deploy of
invintelx.org fails unless `fly secrets set` was run before it**, and INVX-34's one-time setup list
does not currently name these two among its Fly app, `FLY_API_TOKEN`, GHCR package, DNS and
certificates. Whichever of the two branches lands second is the one that should close that gap.

The log from that failure is not a mystery to solve. `env.ts` prints every problem at once, names
the variable, and in production points back at this page:

```
Invalid environment configuration:
  - MONGODB_DB: MONGODB_DB must be set explicitly when NODE_ENV=production - production and
    staging are told apart by database name alone, so falling back to a default would point a
    staging deploy at production's data

See docs/atlas.md, "What the API needs in its environment", for the full production set
and how each value reaches the container.
```

## Secrets

The connection string contains the password, so the string is a secret in full — not a URL with a
secret in it, and not something to paste into a ticket, a commit or a log. `apps/api/src/reconcile.ts`
already redacts credentials before printing the URI, which is the standard the rest of the code
should hold to.

Where they live is Fly's secret store — `fly secrets set`, above — which encrypts them at rest and
injects them as real environment variables into the machine. Where they do **not** live: `.env` is
gitignored, `.env.example` carries placeholders only, `fly.toml`'s `[env]` block is committed and so
holds nothing secret, INVX-34's `.dockerignore` excludes `.env` from the image, and
`.github/workflows/gitleaks.yml` scans every push.

Setting a secret restarts the app, so set all of them in one command rather than one per call — each
separate call is another rolling restart, and a machine that restarts holding half the new
credentials is a deploy that fails for a reason nobody wrote down.

Rotating one is a three-step move with no downtime: add a second Atlas user, `fly secrets set` the
new string, delete the first once the new machines are healthy. In that order — deleting the Atlas
user first takes production down until the deploy finishes. Worth doing once deliberately so it is a
known procedure before it is an incident.

## Provisioning checklist

1. Create the cluster in **AWS `eu-west-2` (London)**, matching Fly's `primary_region` — confirm the
   two still agree before creating it, because moving a live database later is not a small job.
   Record the cluster's name and tier here.
2. Create `invintelx` and `invintelx_staging`. Empty is fine; the API creates its own collections and
   indexes on first boot.
3. Create the two application users, each `readWrite`-scoped to one database.
4. Set the IP allowlist. Confirm `0.0.0.0/0` is not in it. If Fly turns out to have no dedicated
   egress address and this ends up as documented ranges, write that into this page as a known
   compromise, with the ranges and the date.
5. Turn on cloud backup and set retention. Record the numbers in the table above.
6. `fly secrets set` the connection string, `MONGODB_DB` and `SESSION_SECRET` on each app — **before
   the first deploy, not after.** Without them the container exits at boot by design and the release
   rolls back; see "How each of those reaches the container" above.
7. Boot the API against staging and watch the log: it runs migrations, creates indexes and prints a
   setup token. `/api/health` reports the running version.
8. Take a snapshot, restore it into a scratch database, and run `pnpm db:verify` against it. Until
   that has been done the backups are configured, not proven.
9. Come back and delete the status note at the top of this page.
