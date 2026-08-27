# Contributing to InvIntelX

Everyone taking part here — issues, pull requests, review comments — is expected
to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Opening an issue

There are two forms: a bug report and a feature request. Both ask which
deployment you saw it on, and that question is doing real work — see
[Scope](#scope) at the bottom. Please do not open a public issue for a security
problem; report it privately instead, using the link on the new-issue page.
[SECURITY.md](SECURITY.md) is that route written out: what to put in a report,
what happens after you send one, and the things that are documented behaviour
rather than vulnerabilities.

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

## The bundle has a size budget

`pnpm build` measures what the web app makes a first-time visitor download —
the entry chunk, everything it imports synchronously, and the stylesheet — and
fails if it is over the ceiling in `apps/web/vite.config.ts`. There is a second
ceiling on the build as a whole, which catches weight that only ever lands in a
lazily loaded screen.

If a change breaches it, there are two honest answers and no third one:

- Put the new weight behind a dynamic import. Screens are already loaded this
  way — add the route to `apps/web/src/routes/router.tsx` the same way the
  others are, and its chunk stays off the first paint.
- Raise the number, and say in the pull request what it buys. The budget is
  meant to make growth a decision rather than a drift.

A new screen costs nothing until somebody navigates to it, so the budget should
not move for one. A new dependency in the *entry* path is the case worth
arguing about.

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

Branch off `main`. One branch per change — a branch carrying two unrelated
changes gets reviewed at the speed of whichever half is harder.

Branch names are lowercase and hyphenated, and lead with the ticket id when
there is one:

```
invx-37-readme-and-templates      # ticket id, then a few words about the change
invx-60-csv-parse-error
supplier-lead-time-tooltip        # no ticket: just the few words
```

Nothing enforces this — it exists so that a list of branches reads as a list of
work rather than a list of initials and dates.

Keep the commit subject line in the imperative mood and explain the *why* in the
body when the change is not obvious. Reference the ticket id (`INVX-nn`) in the
subject when there is one, the same way the existing history does.

## How a pull request gets reviewed

Open it against `main` and describe what changes in terms of behaviour. The pull
request template asks for three things — what changes, why, and how you checked
it — and the third is the one that matters most: say what you actually ran and
what it printed. A reviewer can read the diff; they cannot read your terminal.

**Two automated gates run on every pull request, and both must be green before
anybody looks at it properly.**

- **CI** (`.github/workflows/ci.yml`) runs `pnpm typecheck`, `pnpm lint`,
  `pnpm test` and `pnpm build` — the same four commands listed above. The test
  step boots a real `mongod`, and it includes the upgrade suite, so a migration
  that loses a row fails here rather than on somebody's warehouse.
- **The secret scan** (`.github/workflows/gitleaks.yml`) runs over the full
  history, not just your diff. A credential you committed and then removed in a
  later commit still fails it — the fix is to rewrite the branch, not to add
  another commit on top.

Then a maintainer reads it. Review is asynchronous and there is no promised
turnaround; this is a small project and the reviewer has a day job. A nudge
after a week is fair and not rude.

What the reviewer is actually looking for, roughly in the order they will
notice it:

1. **Is the behaviour the right behaviour?** The tests prove the code does what
   it does. Only a human can say whether that was the thing to do, which is why
   the *why* in your description does real work here.
2. **Does the contract live in `packages/shared`?** Anything crossing the
   network boundary is a Zod schema both sides import, not an interface written
   twice.
3. **Do the tests fail without the change?** Especially where a behaviour rests
   on a database guarantee — a unique index, a TTL, a transaction.
4. **Is the changelog line there, and is it written for the person deciding
   whether to upgrade?** If the change breaks or migrates something, it belongs
   under those headings specifically.
5. **If it touches migrations or the ledger**, the extra obligations in
   [docs/migrations.md](docs/migrations.md): a fixture, and a declaration of what
   the migration does to `movements`.

Expect comments. A change request is the normal outcome of a first review and is
not a judgement about you. Push follow-up commits to the same branch rather than
opening a new pull request — the discussion is worth keeping attached to the
work.

Before your first pull request can be merged you need to have signed the CLA;
see below. After that, a maintainer merges it to `main`, and it goes out with
the next tagged release ([docs/releasing.md](docs/releasing.md)).

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

**invintelx.org is the only supported deployment.** It is what the project is
developed against and what gets exercised daily.

Self-hosting is permitted and we will take patches that make it easier — but it
is not *supported*: there is no published image, no proven upgrade path for a
live instance, and a question about your own Kubernetes, Docker, reverse proxy
or TLS may go unanswered, because it is not a question about InvIntelX. That
line is worth being precise about, because the two sides of it get treated very
differently:

- **A bug in InvIntelX** — something the software does that contradicts what it
  says it does — is welcome wherever you noticed it, self-hosted included. If it
  reproduces in a dev checkout, say so; that makes it trivially triageable.
- **A problem with your deployment** — the container will not start, the cookie
  is not being sent through your proxy, your cluster does something unusual — is
  not a bug in InvIntelX, and may get no answer.

Unsupported is not the same as undocumented, and the pages exist even though the
promise does not. [docs/deployment.md](docs/deployment.md) is what an instance
needs around it — TLS, the proxy, the cookies, the health probe.
[docs/configuration.md](docs/configuration.md) is every environment variable and
what a wrong value looks like from the outside, generated from the Zod schema the
API boots against. [docs/support-policy.md](docs/support-policy.md) draws the
line above in more detail, including what is out of scope no matter where you saw
it. A patch that makes any of those truer is welcome on the same terms as a code
change.

That is why the issue forms ask which deployment you saw it on. Answer it
honestly rather than tactically; an answer of "my own self-hosted deployment"
does not get the issue closed, it gets it read with the right question in mind.
