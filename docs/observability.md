# Observability

What an InvIntelX instance tells you about itself: structured logs with a
request id threaded through them, errors collected from both the API and the
browser, and a health endpoint worth polling.

Written for whoever is on the end of a pager, not for whoever wrote the code.

## The health endpoint

```
GET /health          → 200 {"status":"ok","version":"0.1.0","revision":"b43576b","database":true,"uptimeSeconds":412}
GET /api/health      → the same handler, the same answer
```

Two paths because hosts differ and a probe misconfigured by one path segment
reads as "the instance is down" for as long as nobody notices. Point your
platform at either.

It is **unauthenticated on purpose**. "Which version is this?" is the first
question of every deployment bug report, and an operator who cannot sign in
still has to be able to answer it. Nothing in the response is a secret.

| Field | Meaning |
| --- | --- |
| `status` | `ok`, or `degraded` when the database is unreachable |
| `version` | The release this process is running, from `apps/api/package.json` |
| `revision` | The commit it was built from, or `unknown` — see below |
| `database` | Whether a `ping` to Mongo just succeeded |
| `uptimeSeconds` | Since this process started, not since the deploy |

**It returns 503 when the database is unreachable**, and that is the point of
polling it. A process that is listening but cannot read anything is not
healthy; a probe that only checked the port would keep it in the load balancer.
Configure the platform to take a 503 instance out of rotation.

### Telling two deploys apart

`version` is a tag, and consecutive deploys usually share one. That makes a
smoke check able to prove the site is up but not that the deploy — or the
rollback — took effect, which is the question actually being asked at the time.

`revision` is the commit, and it answers that. Set `BUILD_REVISION` at build
time from the same value the image stamps into
`org.opencontainers.image.revision`; the deploy workflow already knows the sha.
It is optional and never fatal, because an image built by hand has no sha to
offer and refusing to boot over a cosmetic field would turn a missing label into
an outage. Unset, or set to anything that is not a plausible build identifier
(`[A-Za-z0-9._-]`, 64 characters or fewer), reports `unknown` rather than
echoing it back — this response is published to anyone who can reach the
endpoint.

### The field names are a contract

Two things outside this repository match on the response text rather than
parsing it: the image's `HEALTHCHECK`, which fails the container on any non-2xx,
and the container smoke job in CI, which greps the body for `"status":"ok"` and
`"database":true` as literal substrings. Renaming a field, or answering
`healthy` instead of `ok`, passes every unit test and fails the release.
`apps/api/src/routes/health.contract.test.ts` asserts those exact substrings so
that the break shows up in the suite instead.

Each check costs one round trip to Mongo. It is mounted ahead of the session
lookup, so a probe every three seconds does not become a session query every
three seconds.

## Log lines

NDJSON on stdout, one JSON object per line, in
[pino](https://getpino.io)'s record format. The process does not write files or
rotate anything — the process manager owns the stream, which is what every
container platform expects.

```json
{"level":30,"time":1756268063326,"pid":1,"hostname":"api-01","requestId":"9c8f…","event":"request","method":"GET","url":"/api/items?page=2","status":200,"durationMs":14.2,"userId":"665f…","ip":"203.0.113.7","msg":"request completed"}
```

| Level | Number | Used for |
| --- | --- | --- |
| `trace` | 10 | Nothing yet |
| `debug` | 20 | Health probes and static assets — routine traffic that would otherwise drown the log |
| `info` | 30 | Ordinary requests, boot, shutdown, migrations |
| `warn` | 40 | 4xx responses; a reporter that failed |
| `error` | 50 | 5xx responses; anything captured as an exception |
| `fatal` | 60 | Uncaught exceptions and a failed boot |

Set the floor with `LOG_LEVEL` (`trace`…`fatal`, or `silent`). Default `info`,
and `silent` under `NODE_ENV=test` so hundreds of request lines do not bury a
failing assertion.

`LOG_FORMAT` picks the rendering: `json` (default in production) or `pretty`
(default everywhere else), which is a readable line for a terminal. Set it
explicitly when the deployment disagrees with those defaults — a staging
container somebody tails wants `pretty`.

### The request id

Every request gets one, and every line written while handling it carries it:

- **Inbound `X-Request-Id` is honoured** when it matches `[A-Za-z0-9_.:-]{1,128}`
  — so a load balancer that already stamped one keeps its join. Anything else is
  replaced with a fresh UUID, because that header is attacker-controlled and is
  written verbatim into both the log and a response header.
- **Every response carries `X-Request-Id`**, so a bug report can name the exact
  request.
- **Code four calls deep does not have to be handed it.** The id lives in an
  `AsyncLocalStorage` for the duration of the request, so `logger.info()` inside
  a service is stamped with it without a logger being threaded through every
  signature.

To follow one request through everything it did:

```sh
grep '"requestId":"9c8f' /var/log/invintelx.log | jq .
```

### What is never in a log line

Passwords, session tokens and cookies are removed before anything is written,
by `apps/api/src/lib/redact.ts`, which runs on **every** record rather than
being remembered at each call site. It works two ways at once, because secrets
arrive two ways:

- **By key.** Anything whose name contains `password`, `token`, `cookie`,
  `secret`, `authorization`, `apikey`, `credential`, `sessionid` (case and
  punctuation ignored, so `X-Api-Key` and `apiKey` are one rule) becomes
  `[redacted]`.
- **By value.** A Mongo URI with credentials in it, a `Bearer …` copied into an
  error message, a `?setup_token=…` in a URL. Nothing about the *key* of those
  says secret; the string does. This pass also knows the colon forms —
  `"password":"…"` inside a stringified body, `sessionToken: '…'` from a class
  dumping its own fields — because a secret that was serialised *before* it got
  here has no key left for the key pass to match.

It also bounds what a line can be: depth, array length, key count and string
length are all capped, cycles become `[circular]`, and the output is always
JSON-serialisable. A logger that can throw on the shape of what it was handed
is a logger that goes quiet exactly when something has gone wrong — so
`redact()` never throws, and a field it cannot describe costs that field rather
than the record.

The same rule holds one level up. The request line is built inside a `res`
finish listener, which is not the request call stack: no Express error handler
sits above it, so a throw there would leave as an `uncaughtException` rather
than a 500. `requestLog.ts` catches around building the record and falls back to
a minimal line, so losing a field can never cost the process.

If you add a field to a log line and it comes out `[redacted]`, that is the
rule working. Rename the field.

**The one deliberate exception** is the first-admin setup token, which
`apps/api/src/index.ts` prints to `console` at boot. That banner is addressed
to a person and is the token's entire delivery mechanism; routing it through
the logger would mean the redactor correctly ate the one secret in this
codebase that is meant to be printed. See `FIRST_ADMIN_SETUP` in
[.env.example](../.env.example).

## Error tracking

Everything that nobody handled arrives at one function —
`captureException` in `apps/api/src/lib/errorTracking.ts` — which scrubs it and
writes an `exception` event to the log:

```sh
grep '"event":"exception"' /var/log/invintelx.log | jq .
```

Four things reach it:

| Source | Level | Note |
| --- | --- | --- |
| A 5xx from any route | `error` | 4xx is the system working and is deliberately *not* reported |
| `uncaughtException` | `fatal` | Logged, then the process exits 1 for the supervisor to restart |
| `unhandledRejection` | `error` | Logged, and the process **keeps running** — see below |
| A browser error posted to `/api/client-errors` | `error` | Carries `side: "web"` |

An unhandled rejection does not kill the process, which differs from Node's
default. Express forwards a rejected route handler to the error middleware on
its own, so a rejection that escapes to the process came from background work —
a fire-and-forget write, a timer — and killing every in-flight request over it
is a worse outage than the bug. They are logged loudly instead; treat one as a
defect to fix, not as noise.

### Errors in the browser

A crash in the browser is otherwise invisible to you: the request that caused
it returned 200, and the stack exists only on a machine you cannot reach. The
web app reports three kinds to `POST /api/client-errors`, which turns each into
the same `exception` event an API failure produces:

- `render` — caught by a route error boundary, i.e. the user saw a broken page.
  404s and 401s are excluded: the boundary rendered because that is how the
  router reports them, not because anything broke.
- `error` — a throw that never went near React (a timer, an event handler).
- `unhandledrejection` — a promise nobody handled.

Each report carries the page URL, the browser's stack, and the release the tab
was running — a tab left open across a deploy is running code the server no
longer has, and "only happens on the old build" is otherwise an hour of
confusion. Where the crash followed a failed API call, it also carries **that
call's** request id, so one search finds both halves of a bug that crossed the
wire.

The endpoint is unauthenticated, because the errors most worth hearing about
are the ones that stopped somebody signing in. What that costs is an endpoint a
stranger can write to, so: the payload is schema-bounded, it is rate-limited
per IP, the browser reporter dedupes and caps itself at ten reports per page
load, and every field goes through the redactor. A stranger can put a string in
your log; they could already do that with a 404, and the line says `side: web`.

### Sending events somewhere else

`captureException` is the collection point, not the destination. Registering a
reporter sends every capture onward without a single call site changing:

```ts
// apps/api/src/index.ts, before `main()`
import * as Sentry from '@sentry/node';
import { setErrorReporter } from './lib/errorTracking.js';

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, release: VERSION });
  setErrorReporter((event) => {
    Sentry.captureEvent({
      level: event.level,
      message: event.message,
      tags: { side: event.side, requestId: event.requestId ?? 'none' },
      extra: event.context,
    });
  });
}
```

`@sentry/node` is **not** a dependency of this repo, so the above is a recipe
and not live code. A reporter that throws is caught and logged at `warn`; a
broken tracker must not become the incident.

## Swapping in pino itself

The record format here is pino's, exactly — numeric `level`, epoch-millisecond
`time`, `pid`, `hostname`, `msg`, bindings flattened alongside. That is
deliberate: `pino-pretty` renders these lines, every hosted log platform has a
pino preset, and replacing `apps/api/src/lib/logger.ts` is a dependency and a
factory call rather than a rewrite of every call site.

What this module is not is a general-purpose logger — no transports, no worker
thread, no serialiser registry. If you want those:

1. `pnpm --filter @invintelx/api add pino`
2. In `logger.ts`, build the root logger with
   `pino({ level, formatters, hooks })` and keep exporting it as `logger`.
3. Keep the redactor. pino's own `redact` option takes explicit paths, which
   means it only removes secrets somebody remembered to list; the pass in
   `redact.ts` is by *shape*, which is what makes it hold for log lines nobody
   has written yet. Wire it in as a `hooks.logMethod`.

The interface every call site uses — `logger.info(fields, msg)`,
`logger.child(bindings)`, the six levels — is pino's, so nothing else moves.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `LOG_LEVEL` | `info` (`silent` in tests) | Lowest level written |
| `LOG_FORMAT` | `json` in production, `pretty` elsewhere | How a line is rendered |
| `BUILD_REVISION` | unset → `unknown` | The commit reported at `/health` |

The two logging variables are validated at boot with everything else in
`apps/api/src/env.ts`: a bad value stops the process with a readable message
rather than surfacing on whichever request touches it first.

`BUILD_REVISION` deliberately does not work that way. It describes the build
rather than configuring the process, so a malformed one is reported as `unknown`
instead of stopping the boot — a broken label in a pipeline should cost you an
answer at `/health`, not the instance.
