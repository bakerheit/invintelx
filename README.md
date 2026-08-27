# InvIntelX

Open source inventory intelligence. Track SKUs, stock and movements, and get told
which items actually need attention today.

The hosted instance is [invintelx.org](https://invintelx.org).

**You may run your own.** The AGPL grants you that right and this project has no
interest in obstructing it. There is a published image and a compose file that
runs the whole thing — see [Running it with Docker](#running-it-with-docker).
What we do not yet offer is a *supported* self-host story — there is no proven
upgrade path and no promise that a deployment question gets answered. Running it
is allowed and documented; operating it is currently your problem. If that
changes it will be because people actually did it.

Releases are semver tags cut from `main`, and every one of them says what breaks
and what it will do to your database on first boot: see
[CHANGELOG.md](CHANGELOG.md), and [docs/releasing.md](docs/releasing.md) for what
a version number means here. A running instance reports its own version at
`/api/health`, so a bug report can say which release it is against.

> **Status: early.** The first vertical slice works end to end — accounts, sign
> in, and full CRUD over items. The stock ledger and the analytics that give the
> project its name are next. See the roadmap below.

## Stack

| Layer    | Choice |
| -------- | ------ |
| Web      | Vite, React 19, React Router 7, Tailwind 4, shadcn-style components on Radix |
| Data     | TanStack Query, TanStack Table |
| API      | Express 5, TypeScript |
| Database | MongoDB |
| Contract | Zod schemas in `packages/shared`, imported by both sides |

## Layout

```
apps/web        Vite + React front end
apps/api        Express API
packages/shared Zod schemas and types shared by both — the API contract
scripts         Development helpers
```

`packages/shared` is the important one. Request and response shapes are defined
once as Zod schemas, and both the browser and the server validate against the
same definitions, so a contract change that breaks a caller is a typecheck
failure rather than a runtime surprise.

## Running it locally

Requires Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env   # then set SESSION_SECRET
```

Generate a session secret:

```bash
openssl rand -base64 32
```

Start MongoDB. Docker is the default:

```bash
pnpm db:up
```

If Docker is not available or not behaving, run a real `mongod` directly instead
— it downloads the binary on first use and stores data in `.mongo-data`:

```bash
pnpm db:local
```

Load the demo dataset (40 SKUs and a `demo@invintelx.org` admin account):

```bash
pnpm db:seed
```

Then start both apps:

```bash
pnpm dev
```

The web app is on <http://localhost:5173> and proxies `/api` to the API on port
3001, so everything is same-origin in development and session cookies just work.

Sign in with `demo@invintelx.org` / `invintelx-demo-password`.

### Claiming a fresh instance

An instance with no accounts is not owned by whoever registers first. While it
has none, the API mints a **setup token** at every boot and prints it:

```
[invintelx-api] ──────────────────────────────────────────────
[invintelx-api] This instance has no accounts yet. To become its administrator,
[invintelx-api] register and give this setup token:
[invintelx-api]     3Qk8n-example-token-not-a-real-one
```

Register with that token and the account you create is the administrator.
Everyone after them is a member and needs no token. The token is shown once per
boot, replaced by the next boot, and dead as soon as it has made an
administrator — so restart the API if you lose it.

Two knobs, both documented in `.env.example`: `SETUP_TOKEN` pins the token
instead of minting one, for deploys where injecting a secret beats reading a
log; `FIRST_ADMIN_SETUP=open` turns the gate off entirely and hands the instance
to the first registration, which is what a public sign-up product like
invintelx.org wants and nothing else should.

## Running it with Docker

The shortest path to a running instance, and the one that does not need a clone
of this repository. Take [`deploy/docker-compose.yml`](deploy/docker-compose.yml)
and [`deploy/.env.example`](deploy/.env.example), put them in a directory
together, and:

```bash
cp .env.example .env    # then set SESSION_SECRET and WEB_ORIGIN
docker compose up -d
```

That starts two containers: InvIntelX on `127.0.0.1:3001`, and a MongoDB
replica set on a private network with no published port. The app waits for the
database to be ready before it boots, runs its migrations, and then serves both
the API and the web app on the one port. Put a TLS terminator in front of it —
see [below](#putting-a-reverse-proxy-in-front).

The instance has no administrator yet, and it will not hand itself to whoever
finds it first. Read the setup token out of the log and register with it:

```bash
docker compose logs app | grep -A1 'setup token'
```

Upgrading is changing the tag in `.env` and running `docker compose up -d`
again. Read the [changelog](CHANGELOG.md) for the versions you are stepping
over first — it says what breaks and what will run against your database.

```bash
docker compose pull && docker compose up -d
```

The image is published to `ghcr.io/bakerheit/invintelx` on every release, tagged
with the version and — for a full release, never a pre-release — the rolling
`:1.2`, `:1` and `:latest`. It is a single process: the API, the built web
assets and their production dependencies, running as a non-root user, with a
healthcheck against `/api/health` that reports unhealthy when the database is
unreachable rather than pretending a degraded instance is serving.

**Building your own** — necessary if you modify InvIntelX and serve it to other
people, because the AGPL §13 source offer is compiled into the web bundle:

```bash
docker build --build-arg VITE_SOURCE_URL=https://your.host/your-fork -t invintelx .
```

The development database at [`docker-compose.yml`](docker-compose.yml) in the
repository root is a *different stack* and starts Mongo alone. Keep them apart:
conflating them is how a demo database ends up holding real inventory.

## Running it outside a dev checkout

Docker is not compulsory. Vite is a development server and is not the answer in
production either, so instead the API serves the built web app itself:

```bash
pnpm build                                  # builds apps/web/dist and apps/api/dist
NODE_ENV=production pnpm --filter @invintelx/api start
```

> **The `--conditions=production` flag matters.** `pnpm start` passes it for
> you; run Node by hand and you need it too:
>
> ```bash
> NODE_ENV=production node --conditions=production apps/api/dist/index.js
> ```
>
> `packages/shared` exports its TypeScript source by default, which is what
> `tsx` and vite want in a dev checkout and what lets an edit to the contract
> show up without a rebuild. Node cannot load TypeScript, so the compiled API
> asks for the `production` condition and gets `packages/shared/dist` instead.
> Without the flag it asks Node to import a `.ts` file and Node refuses.

One process, one port, one origin. `/api/*` is the API; everything else is
answered from `apps/web/dist`, falling through to `index.html` so that
refreshing the page on `/items/abc123` still loads the app instead of 404ing.
Same origin is also what lets the session cookie stay `SameSite=Lax` with no
CORS arrangement at all.

The API finds `apps/web/dist` on its own. Set `WEB_DIST` only if the assets live
somewhere else — and note that pointing it at a directory with no `index.html`
is a boot failure rather than a warning, because an instance that 404s every
page is not a useful thing to have started.

Set `WEB_ORIGIN` to the public URL of the instance, and `NODE_ENV=production`,
which is what turns on the `Secure` flag for the session cookie and makes the
API trust one layer of `X-Forwarded-For` for rate-limiting.

Static files are served with cache headers that assume a Vite build: the hashed
files under `assets/` are immutable and cached for a year, while `index.html`
and anything else keeping its name across releases is revalidated every time —
otherwise an upgrade would never reach a browser that had been there before.

### Putting a reverse proxy in front

An option, not a requirement. Terminating TLS in nginx or Caddy and proxying
everything to the API needs no InvIntelX configuration beyond the above:

```
# Caddy
invintelx.example.com {
  reverse_proxy localhost:3001
}
```

If you would rather the proxy served the static files itself, point it at a copy
of `apps/web/dist` and route `/api` to the API. Both must answer on the **same
host and port** as far as the browser is concerned: split them across two
origins and the session cookie stops being sent, and that topology additionally
needs `WEB_ORIGIN` set to the web origin and `SameSite=None; Secure` cookies,
which is not currently wired up.

In that arrangement the API will still serve its own copy of the assets if
`apps/web/dist` happens to sit next to it, which is harmless — the proxy never
asks it to. If you would rather it did not, build only the API with
`pnpm --filter "@invintelx/api..." build` and it will log that it is serving
`/api` only. The trailing `...` is not a typo: it pulls in `packages/shared`,
which the compiled API needs as JavaScript.

None of this is a supported deployment yet — see the status note at the top.
Releases are tagged, there is a published image and there is a changelog to read
before you move, but there is no upgrade that has been proven across a version
boundary. It is how you run it today, honestly described.

### Backups

The movement ledger is the only thing here that cannot be recomputed from
something else, and on-hand quantity is the only thing that can. That shapes both
halves of the job: what to dump, and how to prove a restore worked.

```bash
pnpm db:verify    # recompute on-hand from the ledger and compare. Writes nothing.
pnpm db:rebuild   # then, if you accept the ledger, write the recomputed figures.
```

`pnpm db:verify` is what turns "did the restore work" into a check rather than a
hope: it exits non-zero if the on-hand figures that came out of the archive
disagree with the ledger they are supposed to be derived from, which is what a
dump taken without a consistent snapshot leaves behind. Run it before rebuilding
— a rebuild makes the numbers agree without making them right.

[docs/backup-and-restore.md](docs/backup-and-restore.md) has the whole procedure:
what to dump, how to get a point-in-time snapshot out of the replica set, where
the compose volume lives and why you should not copy it, and the restore
walkthrough that ends at the check above. It is written and checked but not yet
proven: nobody has run it end to end against a real deployment, and the page says
so at the top until somebody has.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm test` boots a real `mongod` for the API suite rather than mocking the
driver. A mock will cheerfully agree that a duplicate SKU is fine; only the
actual unique index proves otherwise.

## Design decisions worth knowing

**Stock will be event-sourced.** `StockMovement` is an append-only ledger and
on-hand quantity is a projection derived from it, never edited directly. A
mistake is corrected with a compensating movement, the way a real stock ledger
works. This costs more up front and buys full history, auditability, and the
demand series the analytics need. A mutable quantity column would make honest
forecasting impossible.

**Money is stored as integer cents.** Inventory valuation sums quantity × unit
cost across every SKU in the business, and doing that in floating point
accumulates drift that produces a total nobody can reconcile. The wire format is
integers; only the presentation layer sees a decimal.

**Items are archived, never deleted.** Once a movement references an item,
deleting the item would leave the ledger pointing at nothing.

**Sessions are opaque tokens hashed at rest.** The database stores a SHA-256 of
a 256-bit random token, so a dump of the sessions collection does not hand
anyone a set of live sessions.

## Roadmap

- [x] Monorepo, shared Zod contract, CI
- [x] Accounts and session auth
- [x] Items — model, API, and screen
- [ ] Locations with a warehouse/bin hierarchy
- [ ] StockMovement ledger and on-hand projection
- [ ] Receive, issue, transfer, adjust, cycle count
- [ ] Purchase orders and receiving against a PO
- [ ] Demand series, days of cover, reorder suggestions
- [ ] ABC classification and dead stock
- [ ] Dashboard

## Licence

[GNU Affero General Public Licence v3.0](LICENSE). Copyright (C) 2026 Andrew Baker.

AGPL rather than a permissive licence for one specific reason: §13 is the only
clause that reaches software offered as a service. It means nobody can take this
code, run a closed hosted fork of exactly what invintelx.org is, and give
nothing back.

**It does not restrict self-hosting.** Running InvIntelX on your own
infrastructure — modified or not — for your own use triggers no obligation
whatsoever. §13 applies only if you modify it *and* offer the modified version
over a network to other people, in which case those people are entitled to your
source. Internal use is unencumbered.

If the AGPL is genuinely incompatible with your situation, ask — a commercial
licence is possible precisely because contributions are taken under a CLA.

## Contributing

Contributions are welcome and require signing the
[Contributor Licence Agreement](CLA.md). You keep the copyright in your work;
the agreement grants the project the right to relicense, which is what makes a
commercial exception possible without hunting down every past contributor. See
[CONTRIBUTING.md](CONTRIBUTING.md).
