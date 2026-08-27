# Changelog

What changed in each release of InvIntelX, written for the person deciding
whether to upgrade — not assembled from commit subjects.

Every released section leads with the two things that decide an upgrade:

- **Breaking** — what stops working, and what to change before you upgrade.
- **Migrations** — what the release does to your database on first boot,
  because that is the part you cannot undo by pulling the old tag back.

Both are always present, even when the answer is `_None._`. Silence in a
changelog reads as "nothing breaks", and it should only read that way when
somebody actually checked.

Versions are [semver](https://semver.org). What counts as a breaking change for
a self-hosted instance is spelled out in [docs/releasing.md](docs/releasing.md).

Changes land here under `## [Unreleased]` as they are merged; cutting a release
renames that heading to the version and the date.

## [Unreleased]

### Breaking

_None._ This is the first release, so there is nothing to upgrade from.

### Migrations

_None._ The API creates its indexes at boot, which is idempotent and safe to
repeat. There is no schema migration mechanism yet, so an instance started on
this release is on the only shape the data has ever had.

### Added

- Accounts and session sign-in. Sessions are opaque tokens stored as a SHA-256
  hash, so a dump of the sessions collection hands nobody a live session.
- Items: model, REST API, list screen with URL-backed filtering, sorting and
  paging, and a detail page showing an item's movement history.
- Locations with a warehouse/bin hierarchy.
- An append-only `StockMovement` ledger with on-hand quantity as a projection
  derived from it. Receive, issue, transfer, adjust and reversal, with a screen
  to move stock.
- Suppliers: model and REST API, with contact details, payment terms and the
  lead time the supplier *promises*. That number is stored on its own and is
  never written back from observed receipts, so the analytics epic can show the
  gap between what a supplier says and what they do.
- A supplier's catalogue: which items they supply, their own part number for
  each — kept in their casing, because it goes on the purchase order — and the
  quantity price ladder they sell it on.
- An audit log for every change that is not a stock movement. The ledger already
  records who moved stock and why; this records who changed a cost, a reorder
  point, a supplier's terms, a location's status or an account's role, with the
  value it held before and the value it took. Append-only, and written by the
  same layer that performs the mutation and in the same transaction, so a write
  that is refused leaves no entry and an entry cannot exist without its write.
  Secrets are never valued: a password change is recorded as an event with no
  before and no after. An item's own history appears on its detail page for
  anybody who can read the item; the whole log is at `/audit` and via
  `GET /api/audit` for administrators only.
- Analytics over the ledger: demand series, days of cover, reorder suggestions
  and an action list of the items that need attention today.
- A landing dashboard that ranks what needs a decision: SKUs that are out of
  stock, SKUs at or below their reorder point, and dead stock worth money —
  each row linking to the item it is about. Total inventory value and a
  movement-volume sparkline sit under the lists as context. Served by
  `GET /api/analytics/dashboard`, which takes `windowDays`, `leadTimeDays`,
  `serviceLevel`, `deadStockDays` and `limit`. Each list reports the full count
  alongside the rows it shows, so a shortlist is never mistaken for the total.
- A deliberate act between deploying an instance and it having an
  administrator. While an instance has no accounts the API mints a **setup
  token** at each boot and prints it; registration will not create an
  administrator without it. `SETUP_TOKEN` pins the token instead of minting
  one, and `FIRST_ADMIN_SETUP=open` turns the gate off for a public sign-up
  deployment. See the README.
- The API serves the built web app itself, so a production instance is one
  process on one origin. `WEB_DIST` overrides where it looks; pointing it at a
  directory with no `index.html` is a boot failure rather than a warning.
- The web app is split by route, so a signed-out visitor downloads the login
  screen rather than the whole product. First paint went from 231 kB to 150 kB
  gzipped, which is the number that decides how long a warehouse tablet on bad
  wifi stares at a blank page. Screens, and the vendor code only they use,
  arrive when they are navigated to. The build now enforces a size budget and
  fails if the bundle outgrows it.
- `/api/health` reports the running version, so a bug report can say which
  release it is against.
- Rate limits on sign-in and registration, counted in MongoDB against a TTL
  index rather than in each process's memory. The quota is the deployment's, so
  running a second API instance no longer doubles it — which is what running
  more than one of them needed before it could be done safely. Each instance
  opens buckets for at most 10000 distinct addresses per window, so the client
  does not get to choose how much of the database it fills.
- A documented backup and restore procedure, and a command that checks a restore
  rather than assuming it. `pnpm db:verify` recomputes every on-hand figure from
  the ledger and compares it with what is stored, writing nothing and exiting
  non-zero if they disagree — which is what a dump taken without a consistent
  snapshot leaves behind. `pnpm db:rebuild` does that, recomputes, and checks
  again. See [docs/backup-and-restore.md](docs/backup-and-restore.md).
- An answer to "may I skip versions", and a test that earns it. **Skipping is
  allowed within a major version and not across one** — read `0.x` → `0.y` as
  the major rule while this project is pre-`1.0.0`. Every released version's
  database shape is kept as a frozen fixture; the upgrade suite restores each
  one, runs the current build's migrations and index creation over it in a
  single hop, and asserts that no document was lost, that no movement was
  altered unless a migration declared it, and that every on-hand figure still
  reconciles against the ledger it is derived from. It runs on every pull
  request and again as its own gate on every release, which also refuses a
  release that arrived without a fixture of its own. See
  [docs/upgrading.md](docs/upgrading.md).
- Licensed AGPL-3.0-or-later, with the section 13 source offer the licence
  requires wired into the running app via `VITE_SOURCE_URL`. Point it at your
  own source if you modify InvIntelX and serve it to other people.
- A private route for reporting a security hole, and a written support policy
  that says where the commitment ends. [SECURITY.md](SECURITY.md) is the
  disclosure route — a GitHub private advisory, never a public issue — with what
  to include, what happens after you send it, and the list of documented
  behaviours that are not vulnerabilities.
  [docs/support-policy.md](docs/support-policy.md) says which versions get fixes
  and for how long, and what belongs to whoever is operating the instance rather
  than to the application.

### Known limitations

- The dashboard cannot show incoming deliveries running late. Purchase orders
  do not exist yet, so nothing in the product knows what is on its way or when
  it was promised. The screen says so where that section would be, rather than
  leaving it out and reading as "no delivery is late".
- Dashboard figures count the active catalogue only, inventory value included.
  Stock left on an archived SKU is invisible on that screen.
- No published container image and no `docker compose up` that runs the app —
  `docker-compose.yml` starts MongoDB for development and nothing else.
- The upgrade suite exercises the *database*: it restores a recorded shape and
  runs the real migration runner and index creation over it. It does not stand
  up the previous release's process and talk HTTP to it, because there is no
  published image to stand up. Your data is proven to survive the new code; old
  and new serving traffic side by side during a rolling deploy is not.
- Being the first release, the only boundary anything has actually been carried
  across is a database predating the migration mechanism arriving at schema
  version 1. The fixture set is one release wide until there are two releases.
- The restore procedure is documented and its final check is tested, but nobody
  has yet run it end to end against a real deployment. An untested backup is a
  belief; treat it as documented rather than proven.
- Self-hosting is permitted and documented but not *supported*. See the README,
  and [docs/support-policy.md](docs/support-policy.md) for where the line
  currently sits.
