<!--
  Thanks for sending this. CONTRIBUTING.md explains how it gets reviewed and what
  the reviewer is looking for; the boxes below are that list in short form.
-->

## What this changes

<!-- The behaviour that is different afterwards, in a sentence or two. Not a
     restatement of the diff — a reviewer can read the diff. -->

## Why

<!-- The problem it solves. Link the issue or ticket id (INVX-nn) if there is one. -->

## How you checked it

<!-- The commands you ran and what they printed, or the steps you clicked through.
     "CI is green" is not a substitute for saying what you actually exercised. -->

---

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` passes locally
- [ ] Tests cover the change — and for anything that depends on a database
      guarantee, a test that would fail without it
- [ ] Anything crossing the network boundary is a Zod schema in `packages/shared`,
      not a hand-written interface
- [ ] `CHANGELOG.md` has a line under `## [Unreleased]` if this is visible to
      somebody running an instance — under **Breaking** or **Migrations** if it is
      either of those (purely internal changes need no entry)
- [ ] A database migration, if any, ships with the fixture and declaration
      [docs/migrations.md](https://github.com/bakerheit/invintelx/blob/main/docs/migrations.md)
      asks for
- [ ] I have signed the
      [CLA](https://github.com/bakerheit/invintelx/blob/main/CLA.md) — one line in `CONTRIBUTORS.md`,
      once, covering everything I ever contribute
