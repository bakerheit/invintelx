# Contributing to InvIntelX

## Getting set up

See the README for the local development loop. In short: `pnpm install`, copy
`.env.example` to `.env`, start Mongo with `pnpm db:up` (or `pnpm db:local` if
Docker is unavailable), `pnpm db:seed`, then `pnpm dev`.

## Before opening a pull request

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

CI runs exactly these. Running them locally first saves a round trip.

## How the code is organised

Anything that crosses the network boundary belongs in `packages/shared` as a Zod
schema. Do not hand-write a TypeScript interface for a request or response body
— define the schema, infer the type from it, and let both sides import it.
That is what keeps the client and the server from drifting apart.

New list screens should copy the shape of the items screen rather than inventing
their own table. The URL-backed table state and the shared `DataTable` exist so
that filtering, sorting and paging behave the same way everywhere.

## Tests

API tests run against a real `mongod`, not a mock. If a behaviour depends on a
database guarantee — a unique index, a TTL, a transaction — write a test that
would fail without it.

## Commits and branches

Branch off `main`. Keep the subject line in the imperative mood and explain the
*why* in the body when the change is not obvious. Reference the ticket id
(`INVX-nn`) when there is one.

## Scope

InvIntelX is developed for the hosted instance at invintelx.org. Contributions
that add supported self-hosting, packaging, or deployment targets are out of
scope; contributions to the application itself are very welcome.
