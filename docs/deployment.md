# Deploying InvIntelX

What an instance needs around it: TLS, a reverse proxy that tells the truth about its clients, the
cookie rules that make sign-in work, and the endpoint to point a probe at.

Every environment variable is documented separately in
[the configuration reference](configuration.md), which is generated from the schema the API boots
against. This page is about everything that is not a variable.

> **Status.** Self-hosting is permitted and documented, not *supported* — see the note at the top
> of the [README](../README.md). There is no published container image yet, and starting the
> process from a source build has a known gap of its own (below). The operational rules on this
> page — TLS, proxying, cookies, the probe — are true today and do not change when the image
> lands.

## What an instance is

One Node process and one MongoDB replica set.

The process serves `/api/*` itself and answers everything else from the built web app, so a
deployment is **one origin on one port**. That is not a packaging convenience: the session cookie
is `SameSite=Lax`, which works precisely because the browser never crosses an origin. Splitting the
web app onto a second origin breaks sign-in and is not currently wired up — see `WEB_ORIGIN` in the
configuration reference for exactly how it breaks.

MongoDB must be a **replica set**, single-node included. A stock movement and the on-hand figure it
changes are written in one transaction, and MongoDB offers transactions only on a replica set. An
instance pointed at a standalone `mongod` boots, signs people in, shows the item screens, and fails
the first time anybody moves stock.

**Run one API process for now.** The sign-in rate limiter keeps its counters in memory, so two
processes each allow the full quota and the limit is quietly twice what it says. That is tracked as
INVX-59 and is a real constraint on horizontal scaling, not a rough edge. Two processes are safe as
far as the *database* is concerned — migrations take a lock in the version document and one process
waits for the other — but the limiter is not ready for it.

## Starting the process

From a source checkout:

```bash
pnpm install
pnpm build                                    # builds apps/web/dist and apps/api/dist
NODE_ENV=production node apps/api/dist/index.js
```

> **Known gap.** That last command does not work yet, for a reason unrelated to serving the
> frontend: `packages/shared` declares `./src/index.ts` as its entry point and emits no JavaScript,
> so the compiled API asks Node to import a TypeScript file and Node refuses. Development is
> unaffected, because `tsx` transpiles it. A runnable artifact — an image, and the packaging fix
> behind it — is INVX-78, and until that merges there is no start command this page can honestly
> tell you to run.

Five things happen before the server listens, in this order: the environment is parsed, MongoDB is
connected to, outstanding migrations run, indexes are ensured, and the first-administrator question
is settled. A failure in any of them exits non-zero rather than serving a request. That is
deliberate — read [docs/migrations.md](migrations.md) for what a stopped boot is telling you.

`SIGTERM` and `SIGINT` close the server, disconnect from Mongo and exit, with a ten-second cap
before the process gives up on a hung connection. Any orchestrator's default stop timeout is longer
than that, so nothing needs configuring.

## TLS

**Terminate TLS in front of the API.** The process speaks plain HTTP and has no certificate
handling, no HTTPS listener and no redirect. That is a deliberate division of labour, not a gap: a
reverse proxy does this better and reloads certificates without restarting your application.

Caddy, which gets a certificate on its own:

```
invintelx.example.com {
  reverse_proxy localhost:3001
}
```

nginx, assuming certbot or similar has put the certificate somewhere:

```nginx
server {
  listen 443 ssl;
  server_name invintelx.example.com;

  ssl_certificate     /etc/letsencrypt/live/invintelx.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/invintelx.example.com/privkey.pem;

  # A CSV import is the one legitimately large request this product makes.
  # nginx defaults to 1 MB, which rejects a few thousand SKUs with a 413 that
  # never reaches the application log.
  client_max_body_size 20m;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

server {
  listen 80;
  server_name invintelx.example.com;
  return 301 https://$host$request_uri;
}
```

Serve the app on **one hostname**. Reaching the same instance as both `example.com` and
`www.example.com` gives you two cookie jars and a sign-in that appears to expire when people follow
a link from the other name. Redirect one to the other in the proxy.

Do not publish MongoDB's port. Nothing outside the API process needs to reach it.

### Why the cookie needs `Secure`, and how it gets it

The session cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, thirty days — and `Secure` **only when
`NODE_ENV=production`**. There is no separate switch for it.

`Secure` is what stops the browser sending the cookie over plain HTTP. Without it, anything that
can get the browser to make one HTTP request to your hostname — a link, an image, a captive portal,
a downgrade attack on a shared network — reads a live session out of the clear. The cookie is a
bearer token: whoever holds it is signed in until it expires.

So the failure mode to understand is this one: **an instance deployed with `NODE_ENV` left at its
default works perfectly, and is leaking sessions to anything that can provoke a plain HTTP
request.** Nothing logs it. Nothing in the UI shows it. It is the single most important line in the
environment for that reason.

Terminating TLS at the proxy does not remove the requirement. The browser is the one deciding
whether to attach the cookie, and it decides on the flag, not on where TLS happened to stop.

### `trust proxy`

With `NODE_ENV=production`, the API sets Express's `trust proxy` to `1`: exactly one hop. `req.ip`
then reads the last entry of `X-Forwarded-For` instead of the socket address, which is the address
of your proxy.

That matters because the sign-in rate limiter keys on `req.ip` — ten attempts per fifteen minutes,
five registrations per hour. Get this wrong and every request in the world shares one key: one
person fumbling their password locks out the entire instance, and a password-guessing attacker
spends everybody's quota. It reads as a mysterious "too many sign-in attempts" for people who have
not tried once.

Two things follow:

- **Your proxy must set `X-Forwarded-For`.** Caddy's `reverse_proxy` does it by default; the nginx
  snippet above does it explicitly.
- **Exactly one proxy.** `1` means one hop. Behind two — a CDN in front of your own nginx — the
  address Express trusts is the CDN's edge rather than the client, and there is currently no
  variable to change the hop count. One proxy, or accept that the limiter counts per edge node.

Do not expose the API's port publicly alongside the proxy. A client that reaches port 3001 directly
can send its own `X-Forwarded-For` and become whatever address it likes.

## The health endpoint

```
GET /api/health
```

Unauthenticated on purpose: "which version is this" is the first question of every deployment bug
report, and an operator who cannot sign in still has to be able to answer it.

```json
{ "status": "ok", "version": "0.1.0", "database": true, "uptimeSeconds": 1421 }
```

- **200** with `"status": "ok"` — the process is up and a `ping` to MongoDB succeeded.
- **503** with `"status": "degraded"` and `"database": false` — the process is up and the database
  is not reachable. Everything that touches data is failing.

Point a liveness or readiness probe straight at it and treat the status code as the answer; it
already includes the database, so a probe does not need to check Mongo separately. The endpoint is
mounted before authentication and does not touch the session store, so it stays answerable when
sign-in does not.

`version` is what the running build reports, which makes it the honest answer to "did the upgrade
actually take". Note that it is the **API's** version: nothing reports the version of the web assets
being served, so a half-finished deploy that updated one and not the other still reports healthy.

Because migrations run before the server listens, an instance in the middle of a long migration
does not answer this endpoint at all — the connection is refused rather than answered with a 503.
A readiness probe should tolerate that with a start-up grace period rather than restarting the
process, because restarting it is how you interrupt a migration.

## Claiming a new instance

A fresh instance has no accounts and is **not** owned by whoever registers first. While it has
none, the API mints a setup token at every boot and prints it:

```
[invintelx-api] ──────────────────────────────────────────────
[invintelx-api] This instance has no accounts yet. To become its administrator,
[invintelx-api] register and give this setup token:
[invintelx-api]     3Qk8n-example-token-not-a-real-one
```

Register with that token and the account you create is the administrator. Everyone after them is an
ordinary member and needs no token. The token is shown once per boot, replaced by the next boot,
and dead the moment it has made an administrator — so restart the process if you lose it.

If reading the log is awkward, set `SETUP_TOKEN` to a value of your own and it is used instead of a
minted one. If — and only if — you are running a public sign-up product, `FIRST_ADMIN_SETUP=open`
removes the gate entirely. On anything else that setting hands your inventory system to whoever
finds it first.

## Static assets and upgrades

The API serves the web build with cache headers that assume Vite's output: content-hashed files
under `assets/` are immutable and cached for a year, and everything that keeps its name across
releases — `index.html` first among them — is revalidated on every request. Do not let a proxy or a
CDN add its own caching on top of `index.html`; caching that one file is how an upgrade fails to
reach a browser that has been to the site before.

Anything the routers do not answer falls through to `index.html`, so a client-side route survives a
refresh. A miss under `/assets/` deliberately does not: it 404s, because answering a missing script
with HTML turns a half-finished deploy into an unreadable MIME error in the browser console.

For what an upgrade does to your database and how to read a boot that stopped, see
[docs/migrations.md](migrations.md). For what a version number means and what a release promises,
[docs/releasing.md](releasing.md).

## Before you need it

[docs/backup-and-restore.md](backup-and-restore.md) is the one to read before the day you need it
rather than on it. The movement ledger is the only thing in the product that cannot be recomputed
from something else, `mongodump` without `--oplog` will not give you a consistent copy of it, and
`pnpm db:verify` is what turns "the restore worked" from a hope into a check.
