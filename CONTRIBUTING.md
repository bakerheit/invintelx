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

## The CLA

Before your first pull request is merged you need to sign the
[Contributor Licence Agreement](CLA.md) — one line added to `CONTRIBUTORS.md`,
once, covering everything you ever contribute.

You keep the copyright in your work. The agreement grants the project the right
to relicense your contribution, which is what allows a commercial exception to
be sold to an organisation that cannot accept the AGPL. Without it every
contribution is AGPL-only forever and that option closes permanently.

If your employer has rights in work you produce, get their permission first.
That is often true even for work done on your own time.

## Scope

InvIntelX is developed against the hosted instance at invintelx.org, and that is
what gets exercised daily. Self-hosting is permitted and we will take patches
that make it easier — but it is not yet *supported*: there are no releases, no
upgrade path, and deployment questions may go unanswered. Say which one you are
working on when you open an issue, so expectations match.
