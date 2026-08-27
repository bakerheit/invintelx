# Deploying invintelx.org

> **Status: written, not yet run.** Every file this page describes is in the
> repository and reviewable. Nothing in it has been executed against a real Fly
> account or a real DNS zone, because the account and the zone do not exist yet
> and no automated agent should be the thing that creates them. Treat the
> commands below as a checklist a person works through once, not as a record of
> something that already happened.

This is the production deployment: one container, one origin, behind a CDN, in
front of Mongo Atlas. It is distinct from [releasing](releasing.md), which is
about cutting versions for people running their own instance.

## The shape of it

```
        invintelx.org
              │
      Cloudflare (DNS, CDN, edge TLS)
              │  cache /assets/*, bypass /api/*
              ▼
        Fly.io  (anycast, TLS to origin)
              │
        one container  ──▶  Mongo Atlas
        /api + the built web app, same port
```

One origin, not two. The API serves the compiled web app itself from the same
port it answers `/api` on — see `apps/api/src/web.ts` for why: the session
cookie is `SameSite=Lax`, which only works because the browser sees a single
origin. Putting the static assets on their own hostname would need
`SameSite=None; Secure` and the CORS path in `app.ts`, and neither is wired up.

So "static assets behind a CDN" is done by putting the CDN in front of
*everything* and letting it cache only what is safe to cache. That costs
nothing in correctness and the app already emits the headers that make it work:
Vite writes content-hashed filenames into `assets/`, which `web.ts` serves as
`immutable` for a year, and everything else — `index.html` included — goes out
`no-cache`. The edge does not need an invalidation step because no cacheable
URL ever changes meaning.

## Why Fly

Fly, Render and Railway would all run this container. The deciding argument was
the rollback requirement, which says rollback is redeploying the previous image
tag:

- **Fly** makes that the primitive. `flyctl deploy --image <tag>` releases an
  image that already exists, without rebuilding, and it is the same command the
  pipeline uses for a forward deploy — so the rollback path is the path that
  runs twenty times a week rather than a second mechanism that is first
  exercised during an incident.
- **Render** rolls back to a previous *deploy* through its dashboard or API,
  and deploying a named image is a paid-plan feature. Good product, but the
  primitive is "that deploy" and not "that tag".
- **Railway** redeploys a previous *build*. Same objection, plus its
  configuration lives in a dashboard rather than in the repository.

Three smaller reasons pointed the same way:

- The database is Atlas (INVX-33), so the usual reason to prefer Render or
  Railway — their managed Postgres — does not apply. Nothing is being given up.
- `fly.toml` is a file in this repository. Every production value gets reviewed
  in a pull request, which matters more than usual here because the people who
  will operate this are not the ones who wrote it.
- `fly scale count` is explicit. The rate limiter keys into process memory
  (INVX-59), so this runs exactly one machine today, and a host that quietly
  scales out would double every limit without telling anyone.

Fly's anycast proxy routes to the nearest machine but does not cache anything,
and one machine in one region means somebody's stylesheet crosses an ocean.
That is what Cloudflare is for, and it is free at this size. If Cloudflare is
not wanted, point the DNS at Fly directly and everything else on this page is
unchanged — you lose the edge cache and nothing else.

## One-time setup

Roughly an hour, done once, by a person with the Fly and Cloudflare accounts.

### 1. The Fly app

```bash
fly apps create invintelx          # the name in fly.toml; change both if taken
fly ips allocate-v4 --shared
fly ips allocate-v6
```

Confirm `primary_region` in `fly.toml` before the first deploy. It is `lhr`
today and it is a placeholder — it wants to be the region the Atlas cluster is
in, because every request makes at least one round-trip there. INVX-33 owns
that choice.

### 2. Secrets

Real environment variables, never a file in the image — `.dockerignore` refuses
`.env` for exactly this reason.

```bash
fly secrets set \
  MONGODB_URI='mongodb+srv://…' \
  SESSION_SECRET='…'             # 32+ chars: openssl rand -base64 32
```

The values are INVX-33's, not this ticket's. `apps/api/src/env.ts` is the list
of what the process requires; a missing or short one kills the boot with a
readable message rather than failing on whichever request touches it first.

### 3. Let the deploy pipeline in

- Set a repository secret `FLY_API_TOKEN` (`fly tokens create deploy -a invintelx`).
  Until it exists the deploy workflow publishes images and says in its run
  summary that it deployed nothing. It starts deploying by itself once the
  token is there.
- Make the GHCR package public, at
  `github.com/bakerheit/invintelx/pkgs/container/invintelx` → Package settings.
  Fly pulls the image anonymously; a private package fails the deploy with a
  manifest error that reads like the tag is missing. Public is the intended
  state anyway — this is AGPL software and self-hosters are meant to be able to
  pull it. If it has to stay private, the alternative is pushing to
  `registry.fly.io/invintelx` instead and changing `IMAGE` in the workflow.

### 4. DNS and TLS

Order matters. Certificates first, proxy second — the other way round, Fly
cannot see the hostname it is being asked to certify.

1. Point the domain's nameservers at Cloudflare, and in the Cloudflare zone add
   these records **DNS-only** (grey cloud) for now:

   | Type | Name | Value |
   | ---- | ---- | ----- |
   | A | `invintelx.org` | the IPv4 from `fly ips list` |
   | AAAA | `invintelx.org` | the IPv6 from `fly ips list` |
   | CNAME | `www` | `invintelx.org` |

2. Ask Fly for the certificates and add what it asks for:

   ```bash
   fly certs add invintelx.org
   fly certs add www.invintelx.org
   fly certs show invintelx.org      # prints the record it wants
   ```

   It will ask for a `_acme-challenge.invintelx.org` CNAME. Add it. That record
   is how renewal works, so it stays there forever — deleting it once the site
   is up is a certificate expiry booked for ninety days later.

3. When `fly certs show` says the certificate is issued, turn the orange cloud
   on for `invintelx.org` and `www`, and set the zone's SSL/TLS mode to **Full
   (strict)**. Full (strict) is the point of having done step 2: it means
   Cloudflare validates Fly's certificate on the way to the origin instead of
   trusting whatever answers.

   `force_https = true` in `fly.toml` handles the redirect at the origin;
   Cloudflare's "Always Use HTTPS" does it one hop earlier. Both on is fine.

4. Two cache rules, in this order:

   | Order | Match | Action |
   | ----- | ----- | ------ |
   | 1 | `starts_with(http.request.uri.path, "/api/")` | Bypass cache |
   | 2 | `starts_with(http.request.uri.path, "/assets/")` | Cache eligible, edge TTL: respect origin |

   The bypass is the one that matters. Cloudflare's defaults would very likely
   not cache `/api/` anyway — it sets cookies, and the paths have no static
   file extension — but "very likely" is not a property you want a signed-in
   user's inventory to depend on. Write the rule.

   Rule 2 is almost a no-op given the same defaults, and it is there so that the
   caching behaviour of this site is something you can read rather than infer.
   Everything it matches is content-hashed, so a stale edge copy is impossible
   by construction: a changed file has a changed URL.

   Do not add a rule that caches `index.html`. It is the one file whose URL
   stays the same across a deploy, which is exactly why the app sends it
   `no-cache`.

## Before any of that: CI builds the image

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) has two jobs. `verify`
typechecks, lints, tests and builds on the runner. `image` builds the
`Dockerfile` and runs what it built — build only, nothing pushed.

It matters because none of `verify` touches the container. Without the `image`
job the first build of the image is a merge to `main` and the first *run* of it
is a production deploy, which is not a place to discover that a workspace
project was added without a `COPY` line.

Three things are asserted against the built image, in this order, so that a
failure names itself:

1. **`@invintelx/shared` resolves to JavaScript** under
   `--conditions=invintelx-dist`, run from `apps/api` because that is the
   project that depends on it. See [below](#why-the-container-passes---conditions)
   for why this is not automatic.
2. **`apps/web/dist/index.html` is in the image**, at the path the API's
   `web.ts` computes relative to its own compiled location. A miss here is an
   image that answers `/api` and serves a blank page to a browser.
3. **The compiled API loads far enough to reach its database.** The real `CMD`,
   the real user, `NODE_ENV=production`, pointed at a port nothing is listening
   on. It is *meant* to fail — reaching `failed to start` proves every module in
   the graph loaded first, and anything unresolvable dies well before that line.
   Five seconds, because `db.ts` pins `serverSelectionTimeoutMS` to 5000.

What this still does not do is run the thing against a real database. The image
is never started against a replica set anywhere in CI, so migrations, indexes
and `/api/health` returning `200` are first exercised by a deploy.

`ci.yml`, `release.yml` and `deploy.yml` all build with `cache-from: type=gha`,
so the publishing build that follows a green `main` mostly reuses the layers CI
already built rather than paying for them twice.

## The pipeline

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

It triggers on the **CI workflow completing successfully on `main`**, not on
the push. That is the whole point: "deployed" cannot get ahead of "verified",
and there is no second copy of the checks to drift out of step with the first.
Since CI now builds the image, "verified" includes "the image builds and
starts".

That trigger matches CI by the `name:` field in `ci.yml` — the word `CI` — and
not by its filename. Renaming the CI workflow does not break the deploy
workflow loudly; it stops it firing at all, silently, and nothing else in the
repository notices. Both files carry a comment saying so.

1. **plan** — decides what is being deployed. A normal run takes the commit CI
   actually ran against and names it `main-<short sha>`. A manual run with an
   `image_tag` skips straight to deploying that tag.
2. **image** — builds `Dockerfile` and pushes two tags: `main-<short sha>`,
   which never moves, and `main`, which does. The immutable one is the rollback
   story; keeping every green main means "the one from before lunch" is always
   still pullable.
3. **deploy** — `flyctl deploy --image`. Never a build. What reaches production
   is always a tag that already exists and has already been through CI.
4. **smoke check** — `GET /api/health` over the public internet, expecting
   `status: ok`, which is 503 rather than 200 when the process cannot reach
   Mongo. Fly's own health check has already gated the release; this is the
   second opinion, from outside Fly's network.

Deploys are serialised and never cancelled. A superseded CI run is fine; a
deploy killed between "old machine stopped" and "new machine healthy" is an
outage.

One thing that surprises people: `workflow_run` only fires for the copy of the
workflow file on the default branch. This workflow does nothing on the branch
that adds it, and cannot be exercised from a pull request. The first time it
runs is the first merge to `main` after it lands — which, with no
`FLY_API_TOKEN` set, publishes an image and says in its summary that it
deployed nothing.

`fly.toml` uses the rolling strategy with one machine, so a deploy is a few
seconds of 503. Blue/green would remove that and would also have the incoming
version run its boot migrations against the database the outgoing version is
still serving from. Nothing in this repository has committed to migrations
being safe across two versions at once, so for now the old machine stops first.
Worth revisiting when there is an expand/contract rule to point at.

## Rolling back

The previous image tag, redeployed. From the Actions tab, run **Deploy** with
`image_tag` set; or:

```bash
gh workflow run deploy.yml -f image_tag=main-a1b2c3d
```

To find the tag, look at the deploy runs — each one names the tag it built in
its summary — or ask Fly what it has released:

```bash
fly releases -a invintelx
fly image show -a invintelx        # what is running right now
```

This does not revert anything in git. It puts a known-good build back in front
of users, which is the urgent half; the revert or fix-forward is a pull request
made at a normal speed afterwards.

A rollback names an image and not a commit, so it deploys the old image with
`fly.toml` **as it currently stands on main**. Ordinary deploys pair each
commit with its own config. If the thing you are rolling back is a change to
`fly.toml` itself, revert that file on main first and let the pipeline run —
picking an older image will not undo it.

**A rollback does not undo a migration.** The API runs migrations at boot
(`apps/api/src/migrations`), and going back to an older image runs an older
version of the code against a database that has already moved. Whether that is
safe is a property of the specific migration, and today the honest answer is
that nobody has checked. Before rolling back across a release that migrated,
read the changelog's *Migrations* section for it. Rolling back between two
builds of the same version — the ordinary case, two commits on main — does not
involve a migration at all.

## Why the container passes `--conditions`

`packages/shared` is consumed as TypeScript source. That is what makes vite,
vitest and tsx work without a build step, and it is also why `node dist/index.js`
could not boot: the API's compiled output still imports `@invintelx/shared`, and
Node cannot load a `.ts` file out of `node_modules`.

`packages/shared/package.json` therefore exports two things under one specifier:
the source by default, and `dist/index.js` under a custom `invintelx-dist`
condition that only the container turns on. Every existing consumer resolves
exactly what it resolved before; `node --conditions=invintelx-dist` gets
JavaScript. The flag appears in the `Dockerfile`'s `CMD` and in `apps/api`'s
`start` script, and those two need to stay in step.

This is the arrangement most likely to be broken by somebody who has no reason
to know it exists — an innocuous edit to `packages/shared/package.json` and the
container stops booting, while every test still passes because tests never turn
the condition on. That is why CI's `image` job resolves the package inside the
built image and prints the file it landed on.

## What is not here

- **The Fly app, the DNS zone and the certificates.** Created by a person, once,
  per the checklist above.
- **Staging.** `fly.toml` describes production. A staging app would be a second
  Fly app and a second config, and INVX-33's separate staging database is the
  half of it that already exists.
- **Anything that identifies which build is running.** `/api/health` reports the
  package version, so two commits on the same version are indistinguishable from
  outside — which means the smoke check can tell you the site is up but not that
  the rollback took effect. Use `fly image show` until that changes.
- **Structured logs and error tracking.** INVX-35.
