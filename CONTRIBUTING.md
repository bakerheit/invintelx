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

## The changelog

If your change is visible to somebody running their own instance — an
environment variable, a data shape, an API response, a default, a fix they were
waiting for — add a line to the `## [Unreleased]` section of
[CHANGELOG.md](CHANGELOG.md) in the same pull request. It is a sentence written
for the person deciding whether to upgrade, not a copy of your commit subject.

If it **breaks** something or **migrates** something, it goes under those
headings specifically. A release cannot be cut until those two questions are
answered, so a missing line becomes somebody else's archaeology later.

Purely internal changes — a refactor, a test, a build tweak — need no entry.

[docs/releasing.md](docs/releasing.md) has the rest: what a version number means
here, and how a release is cut.

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
that make it easier — but it is not yet *supported*: there is no published
image, no proven upgrade path, and deployment questions may go unanswered. Say
which one you are working on when you open an issue, so expectations match.

[docs/support-policy.md](docs/support-policy.md) draws the line properly: which
versions get fixes, what counts as a product bug, and what belongs to whoever is
operating the instance.

## Security

Never open a public issue for a security problem, and never send a fix for one
as an ordinary pull request — a patch is a disclosure, and the commit message
usually explains the attack. [SECURITY.md](SECURITY.md) has the private route;
start there and a maintainer will tell you where the fix should go.
