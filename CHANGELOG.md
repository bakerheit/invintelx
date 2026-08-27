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
- A first run that ends somewhere useful. Registering an administrator now
  lands on a welcome screen offering the two paths that exist — import a CSV,
  or load the demo dataset and look around — and the empty dashboard, item
  table and movement ledger all point at it rather than each apologising on
  their own. The demo dataset is the same 40 SKUs and four months of trading
  that `pnpm db:seed` writes, every row of it flagged, announced by a banner on
  every screen saying the figures are invented, and removable in one press:
  `DELETE /api/onboarding/demo` takes out the demo rows and any movement posted
  against them, and leaves anything you created yourself alone — including any
  demo location or supplier your own stock has come to rest in, which is kept
  and stops being demo rather than being deleted out from under it. It is offered
  only to an instance with nothing in it, so it cannot be mixed into a real
  catalogue, and loading or removing it is an administrator's action.
- The API serves the built web app itself, so a production instance is one
  process on one origin. `WEB_DIST` overrides where it looks; pointing it at a
  directory with no `index.html` is a boot failure rather than a warning.
- `/api/health` reports the running version, so a bug report can say which
  release it is against.
- A documented backup and restore procedure, and a command that checks a restore
  rather than assuming it. `pnpm db:verify` recomputes every on-hand figure from
  the ledger and compares it with what is stored, writing nothing and exiting
  non-zero if they disagree — which is what a dump taken without a consistent
  snapshot leaves behind. `pnpm db:rebuild` does that, recomputes, and checks
  again. See [docs/backup-and-restore.md](docs/backup-and-restore.md).
- Licensed AGPL-3.0-or-later, with the section 13 source offer the licence
  requires wired into the running app via `VITE_SOURCE_URL`. Point it at your
  own source if you modify InvIntelX and serve it to other people.

### Known limitations

- The dashboard cannot show incoming deliveries running late. Purchase orders
  do not exist yet, so nothing in the product knows what is on its way or when
  it was promised. The screen says so where that section would be, rather than
  leaving it out and reading as "no delivery is late".
- Dashboard figures count the active catalogue only, inventory value included.
  Stock left on an archived SKU is invisible on that screen.
- No published container image and no `docker compose up` that runs the app —
  `docker-compose.yml` starts MongoDB for development and nothing else.
- No upgrade has been exercised across a version boundary, because there is no
  earlier version to exercise it from. Whether skipping versions will be
  allowed is not decided yet.
- The restore procedure is documented and its final check is tested, but nobody
  has yet run it end to end against a real deployment. An untested backup is a
  belief; treat it as documented rather than proven.
- Self-hosting is permitted and documented but not *supported*. See the README.
