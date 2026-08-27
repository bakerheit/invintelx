# Images used by the README

## `dashboard.png` — not yet captured

The README has a commented-out line reserving the spot for it, just under the
opening paragraphs. Drop the file in here, uncomment that line, and it is done.

**What to capture:** `/dashboard`, signed in, against the seeded demo dataset —
`pnpm db:seed` then `pnpm dev`, sign in as `demo@invintelx.org`. That screen is
the one worth showing because it is the only one that answers the question the
product's name makes: not "here is your stock", but "here is what needs a
decision today". A screenshot of the items table would show a table, and every
inventory tool has a table.

Get all three ranked lists into the frame — out of stock, at or below reorder
point, dead stock — along with the inventory value and the movement sparkline
beneath them. A viewport around 1440×900 fits them without the page needing to
be scrolled or the browser zoomed out to something no one uses.

**Before you publish it:** the demo dataset is safe to show, a real one is not.
Check the frame for a real person's name, a real supplier, a real cost, and an
email address in the account menu that is not `demo@invintelx.org`. Crop the
browser chrome — bookmarks bars leak more than screenshots usually do.

Keep it under about 500 KB. It is the first thing a visitor loads.
