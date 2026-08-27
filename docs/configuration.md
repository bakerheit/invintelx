# Configuration reference

Every environment variable InvIntelX reads, what a wrong value does, and which two deserve more
care than the rest.

The list below is **generated** from [`apps/api/src/envSchema.ts`](../apps/api/src/envSchema.ts) —
the same Zod schema the API boots against — and the rejection messages are obtained by actually
feeding the schema a bad value, not by remembering what it prints. A variable added to the schema
without a word written about it fails the typecheck; a page edited by hand inside the generated
block fails the test suite. That is the only way a reference like this stays true.

For getting an instance up, see [the deployment guide](deployment.md).

## How configuration is loaded

The API parses its whole environment **once, at import, before it connects to anything**. A missing
or malformed value is a boot failure with a message naming the variable, not a surprise on
whichever request happens to touch it first:

```
Invalid environment configuration:
  - SESSION_SECRET: SESSION_SECRET must be at least 32 characters

See .env.example, or docs/configuration.md for what each variable does.
```

Two sources, in this order:

1. **Real environment variables.** What a container, a systemd unit or a shell export sets. These
   always win.
2. **`.env` at the repository root.** Loaded by `dotenv` for the convenience of a development
   checkout. It is resolved relative to the API source rather than to the working directory, so
   `pnpm dev`, `pnpm seed` and `node dist/index.js` all read the same file.

A deployment should use the first. `.env` exists so a fresh clone runs; a file on disk containing
`SESSION_SECRET` is a thing to back up, leak and forget to rotate.

Everything is read at boot and never re-read. Changing a value means restarting the process.

## The shortest configuration that is not wrong

Two variables have no default and stop the boot without them. One more has a default that is only
correct on a laptop. On a real deployment, start here:

```bash
NODE_ENV=production                                   # see below — this one is not cosmetic
MONGODB_URI=mongodb://mongo:27017/?replicaSet=rs0     # must be a replica set
MONGODB_DB=invintelx
SESSION_SECRET=$(openssl rand -base64 32)             # 32+ characters, kept out of git
```

`NODE_ENV=production` is the variable most likely to be left out, because leaving it out does not
break anything visibly. It is what puts `Secure` on the session cookie and what makes the sign-in
rate limiter see the client instead of your reverse proxy. An instance running with the default is
an instance whose session cookie a browser will send over plain HTTP.

Everything else has a default that is defensible in production, including `FIRST_ADMIN_SETUP` —
which defaults to the safe answer, so an instance is not handed to whoever reaches it first.

## The variables

<!-- generated from apps/api/src/envSchema.ts by `pnpm docs:config` -->

### `NODE_ENV`

**Optional.** Defaults to `development`. One of `development`, `test`, `production`.

Selects the production behaviours, and is the only variable that does. `production` sets `Secure` on
the session cookie, tells Express to trust one hop of `X-Forwarded-For` so the sign-in rate limiter
keys on the client rather than on your reverse proxy, and turns a missing web build into a warning
in the log.

Use `production` for anything that is not a developer machine. `test` is for the test suite and
switches the rate limiter off.

**Refused at boot**

- `NODE_ENV=prod` → `Invalid enum value. Expected 'development' | 'test' | 'production', received 'prod'`

**Accepted, and wrong**

Left at `development` on a real deployment, the instance works — which is the problem. The session
cookie loses `Secure`, so a browser will send it over plain HTTP; every request looks like it came
from the proxy, so one client can spend the whole sign-in rate limit for everybody; and an instance
with no web build says nothing about it. Nothing warns you, because from inside the process this is
a perfectly ordinary configuration.

### `PORT`

**Optional.** Defaults to `3001`. Integer 1–65535.

The port the API listens on. One process answers both `/api` and the web app, so this is the only
port InvIntelX opens.

**Refused at boot**

- `PORT=0` → `Number must be greater than or equal to 1`
- `PORT=70000` → `Number must be less than or equal to 65535`
- `PORT=not-a-port` → `Expected number, received nan`

**Accepted, and wrong**

A port already in use is an `EADDRINUSE` crash at boot, which is loud enough. The quiet one is
changing this and not changing the reverse proxy: the proxy keeps dialling 3001, every request 502s,
and the API log says it is listening perfectly happily.

### `MONGODB_URI`

**Required.** A non-empty string.

How the driver reaches MongoDB. **A replica set is required, not a preference** — a stock movement
and the on-hand figure it changes are written in one transaction, and MongoDB only offers
transactions on a replica set.

Credentials belong in the URI rather than on a command line, where they end up in shell history and
in `docker inspect`.

**Refused at boot**

- unset → `Required`
- `MONGODB_URI=` → `MONGODB_URI is required`

**Accepted, and wrong**

A URI that resolves but is not a replica set gets all the way through boot, serves sign-in and the
item screens, and fails the first time anybody moves stock — an `IllegalOperation` about transaction
numbers, from a deployment that has looked healthy for hours.

The database name in the URI path is **ignored**: `MONGODB_DB` decides that, after the connection is
made. A URI ending `/acme` with `MONGODB_DB` unset writes to `invintelx`, and an operator inspecting
`acme` finds an empty database and no error anywhere.

### `MONGODB_DB`

**Optional.** Defaults to `invintelx`. A non-empty string.

Which database on that server. Applied after connecting, which is why it overrides the database
named in `MONGODB_URI`'s path rather than agreeing with it.

**Refused at boot**

- `MONGODB_DB=` → `String must contain at least 1 character(s)`

**Accepted, and wrong**

Point it at a name that does not exist and MongoDB makes one. The instance is not broken, it is
*empty*: no accounts, no items, and a fresh setup token in the log offering the instance to whoever
reads it. The same mistake ruins a restore — dump under one name, run under another, and nothing you
restored is there.

### `SESSION_SECRET`

**Required.** A string of at least 32 characters.

Generate one with `openssl rand -base64 32`, inject it as a real environment variable, and keep it
out of version control.

> **Nothing in the running code reads this value today.** Sessions are 256-bit random tokens stored
> as a SHA-256 hash; nothing is signed, and `cookie-parser` is mounted without a secret. So changing
> it signs nobody out, and two instances sharing one database can hold different values and still
> accept each other’s sessions. It is required at boot so that a deployment already has one on the
> day something starts signing with it — at which point rotation *will* end every session. Do not
> build a habit of rotating it casually on the strength of it being free right now.

To end every session deliberately — the thing operators actually reach for this variable to do —
empty the `sessions` collection. Everyone is signed out at their next request.

**Refused at boot**

- unset → `Required`
- `SESSION_SECRET=hunter2` → `SESSION_SECRET must be at least 32 characters`

**Accepted, and wrong**

Anything 32 characters or longer is accepted, including 32 spaces and the placeholder in
`.env.example`. Nothing checks entropy, nothing detects the same secret reused across two instances,
and — because nothing reads it — nothing you can observe from outside tells you it is weak. Treat
the boot check as a length check and not as a review.

### `WEB_ORIGIN`

**Optional.** Defaults to `http://localhost:5173`. A URL, including the scheme.

The single origin allowed to make credentialed cross-origin calls to `/api`.

In the deployment this project documents — one process serving both the API and the web app — the
browser is always same-origin and **this value is never consulted**. It matters only if the web
assets are served from a different host or port to the API.

**Refused at boot**

- `WEB_ORIGIN=invintelx.example.com` → `Invalid url`

**Accepted, and wrong**

In a single-origin deployment: no effect whatsoever, including when it is left at the development
default. It being wrong is not a problem you can have.

In a split-origin deployment it is wrong silently, and reaches you as unexplained sign-in failures.
The browser blocks every `/api` call, so the form appears to do nothing, while the API access log
shows the requests arriving and succeeding. The match is an exact string comparison against the
`Origin` header: `https://acme.example` does not admit `https://www.acme.example`, `http://` does
not admit `https://`, and a trailing slash — which the schema accepts and a browser never sends —
never matches anything.

Fixing `WEB_ORIGIN` is also not enough on its own to make that topology work: the session cookie is
`SameSite=Lax`, so a cross-origin sign-in still does not stick. Split origins need cookies marked
`SameSite=None` and `Secure`, which is not wired up. Serve both halves from one origin and none of
this applies.

### `WEB_DIST`

**Optional.** Unset by default. A non-empty string.

Where the built web app is. Unset, the API looks next door in `apps/web/dist`, which is where
`pnpm build` puts it — so an ordinary build needs nothing here. Set it when the layout differs, such
as an image that copies the assets somewhere else.

Serving nothing at all is a valid choice: leave this unset, do not build the web app, and put a
proxy in front that serves the assets itself. The API then answers `/api` only and says so in the
log.

**Refused at boot**

- `WEB_DIST=` → `String must contain at least 1 character(s)`

**Accepted, and wrong**

A directory that exists but holds no `index.html` is a **boot failure**, on purpose — an instance
that 404s every page is not a useful thing to have started. The accepted-but-wrong case is subtler:
point it at a stale build and everything works, at the previous version. `/api/health` reports the
API version, and there is nothing anywhere that reports the version of the assets, so a
half-finished upgrade looks entirely healthy.

### `FIRST_ADMIN_SETUP`

**Optional.** Defaults to `token`. One of `token`, `open`.

How this instance gets its first administrator.

`token` (the default) mints a setup token at every boot while the instance has no accounts and
prints it to the log. Registration will not create an administrator without it, so deploying the
instance and claiming it are two separate acts.

`open` hands the instance to the first account that registers, with no token. That is the right
answer for a public sign-up product and the wrong one for everything else.

**Refused at boot**

- `FIRST_ADMIN_SETUP=open-ish` → `Invalid enum value. Expected 'token' | 'open', received 'open-ish'`
- `FIRST_ADMIN_SETUP=true` → `Invalid enum value. Expected 'token' | 'open', received 'true'`

**Accepted, and wrong**

`open` on anything reachable from the internet means whoever finds it first owns your inventory
system. Nothing about the instance looks different before it happens, and once it has, the product
offers no way to undo it — the takeover is a legitimate first registration. The boot log is the only
warning, and it is printed once.

### `SETUP_TOKEN`

**Optional.** Unset by default. A string of at least 16 characters.

Pins the setup token instead of minting one, for deploys where injecting a secret is easier than
reading a container log. Stored hashed, exactly like a minted one.

**Refused at boot**

- `SETUP_TOKEN=too-short` → `SETUP_TOKEN must be at least 16 characters`

**Accepted, and wrong**

It is **ignored once the instance has an account**, silently — so setting it to get back into an
instance whose administrator has been lost does nothing at all, and the boot log will not mention
it. It is also read only at boot: changing it in `.env` does nothing until the process restarts.

<!-- end generated -->

## Not in the schema

One variable matters to a deployment and does not appear above, because the API never sees it:

### `VITE_SOURCE_URL`

Read by **Vite at build time**, not by the API at boot, so it is baked into the web bundle and
setting it on a running container does nothing. It has no Zod schema and no validation; unset, the
app falls back to `https://github.com/bakerheit/invintelx`.

It is the AGPL section 13 source offer the running app makes to its network users. **If you modify
InvIntelX and serve it to other people, point this at your source, not ours** — otherwise your
deployment offers them source that is not the source they are running, which is not compliance.
Running an unmodified InvIntelX, or a modified one only for yourself, triggers no obligation at
all.

## Keeping this page honest

The generated block is written by the schema:

```bash
pnpm docs:config
```

`pnpm test` fails if the committed page and the schema disagree, so regenerating is part of
changing a variable rather than a chore for whoever notices later. The hand-written prose outside
the markers is yours to edit; anything between them is overwritten.
