# InvIntelX

Open source inventory intelligence. Track SKUs, stock and movements, and get told
which items actually need attention today.

The hosted instance is [invintelx.org](https://invintelx.org).

**You may run your own.** The AGPL grants you that right and this project has no
interest in obstructing it. What we do not yet offer is a *supported* self-host
story — there are no versioned releases, no upgrade path and no promise that a
deployment question gets answered. Running it is allowed and documented;
operating it is currently your problem. If that changes it will be because
people actually did it.

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
