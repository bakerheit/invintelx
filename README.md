# InvIntelX

Open source inventory intelligence. Track SKUs, stock and movements, and get told
which items actually need attention today.

**[invintelx.org](https://invintelx.org) is the only supported deployment.** It
is the instance this project runs, it is what gets exercised every day, and it
is the one a bug report can be filed against and expected to go somewhere.

**You may still run your own.** The AGPL grants you that right, this project has
no interest in obstructing it, and the whole procedure is written down below.
What is not on offer is *support*: there is no published container image, no
proof that a live instance survives an upgrade of its own process, and no
promise that a question about your Kubernetes, your Docker, your reverse proxy
or your TLS gets an answer. Bugs in InvIntelX itself are welcome wherever you
happened to notice them. Bugs in your cluster are yours. If that ever changes it
will be because people actually ran it and said what broke.

<!--
  MAINTAINER — the screenshot this README is missing goes here. Capture it and
  uncomment the line below; nothing else needs to change.

      ![The InvIntelX dashboard: what needs a decision today](docs/images/dashboard.png)

  docs/images/README.md says what to capture and why that shot rather than
  another. It is commented out rather than left pointing at a file that does not
  exist, because a broken image is a worse first impression than no image.
-->

Releases are semver tags cut from `main`, and every one of them says what breaks
and what it will do to your database on first boot: see
[CHANGELOG.md](CHANGELOG.md), and [docs/releasing.md](docs/releasing.md) for what
a version number means here. A running instance reports its own version at
`/api/health`, so a bug report can say which release it is against.

Moving between two of those versions is [docs/upgrading.md](docs/upgrading.md).
The short version: **you may skip versions within a major and not across one**,
and that is a claim with a test behind it — every released version's database
shape is kept and put through the current build's migrations on every release,
checking that nothing was lost and that on-hand still reconciles against the
ledger.

> **Status: early, but whole.** The loop the name promises runs end to end:
> accounts and sign in, items, locations, an append-only stock ledger with
> on-hand derived from it, suppliers and their catalogues, an audit log, and a
> dashboard that ranks what needs a decision today. Purchase orders are the
> large missing piece — nothing in the product yet knows what is on its way or
> when it was promised — and there is no published container image. See the
> roadmap below.

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

Two knobs, both in `.env.example` and in
[docs/configuration.md](docs/configuration.md): `SETUP_TOKEN` pins the token
instead of minting one, for deploys where injecting a secret beats reading a
log; `FIRST_ADMIN_SETUP=open` turns the gate off entirely and hands the instance
to the first registration, which is what a public sign-up product like
invintelx.org wants and nothing else should.

## Running it outside a dev checkout

What follows is the short version, and it is the part that is about *this*
application. [docs/deployment.md](docs/deployment.md) is the whole of it: TLS,
what a reverse proxy has to tell the API about the client in front of it, the
cookie rules sign-in depends on, and the endpoint to point a health probe at.
Every environment variable — and what a wrong value looks like from the outside
— is [docs/configuration.md](docs/configuration.md), generated from the same Zod
schema the API boots against rather than written out by hand and left to rot.

Neither page makes your instance a supported one. They exist so that running an
unsupported instance is still something you can do properly.

Vite is a development server and is not the answer in production. Instead the
API serves the built web app itself:

```bash
pnpm build                        # builds apps/web/dist and apps/api/dist
NODE_ENV=production node apps/api/dist/index.js
```

> **Known issue.** That second command does not work yet, for a reason that has
> nothing to do with serving the frontend: `packages/shared` declares
> `./src/index.ts` as its entry point and emits no JavaScript, so the compiled
> API asks Node to import a TypeScript file and Node refuses. Development is
> unaffected — `tsx` transpiles it. Packaging a runnable build is tracked
> separately.

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
`pnpm --filter @invintelx/api build` and it will log that it is serving `/api`
only.

None of this makes your instance a supported deployment — invintelx.org is still
the only one of those, as the top of this file says. Releases are tagged, there is a changelog to read before you move, and the
upgrade is exercised against a recorded copy of every released database shape
rather than merely described ([docs/upgrading.md](docs/upgrading.md)). What is
still missing is a published image, and a proof that runs the old release's
*process* rather than restoring its data. It is how you run it today, honestly
described.

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

## Security and support

Found a hole? **Do not open a public issue.** [SECURITY.md](SECURITY.md) has the
private disclosure route, what to put in a report, what happens after you send
it, and the list of things that are documented behaviour rather than
vulnerabilities.

[docs/support-policy.md](docs/support-policy.md) is the other half: which
versions get fixes and for how long, what counts as a product bug, and what is
your deployment's problem rather than the application's. Worth reading before
you file anything — it is short, and it is what keeps the answerable questions
answerable.

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
- [x] Locations with a warehouse/bin hierarchy
- [x] StockMovement ledger and on-hand projection
- [x] Receive, issue, transfer, adjust, reverse
- [x] Suppliers, their catalogues and quantity price ladders
- [x] Demand series, days of cover, reorder suggestions
- [x] Dead stock, and a dashboard that ranks what needs a decision today
- [x] Audit log for every change that is not a stock movement
- [ ] Cycle count — `count` exists as a movement type with nothing that posts one
- [ ] Purchase orders and receiving against a PO
- [ ] ABC classification

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
commercial exception possible without hunting down every past contributor.

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: the dev loop, how branches are
named, and what happens to a pull request after you open it. Everyone taking
part — issues, pull requests, review comments — follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

Bugs and feature requests go through the issue forms, which ask which deployment
you saw it on for the reason given at the top of this file. A security problem
is the exception: report it privately using the link on the new-issue page
rather than opening a public issue.
