# InvIntelX

Open source inventory intelligence. Track SKUs, stock and movements, and get told
which items actually need attention today.

The hosted instance is [invintelx.org](https://invintelx.org). This repository is
public so the code can be read, audited and contributed to — it is not packaged
for you to run your own production deployment, and issues about self-hosted
setups are out of scope.

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

Sign in with `demo@invintelx.org` / `invintelx-demo-password`, or register a new
account — **the first account created on an instance becomes the admin.**

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

Not yet chosen. Until a `LICENSE` file lands, no open source grant is offered —
that decision is tracked as INVX-36 and will be made before the repository goes
public.
