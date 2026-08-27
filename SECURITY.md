# Security

InvIntelX holds a stock ledger — real quantities, real costs, real supplier
terms. A hole in it is worth reporting properly, and reporting it properly means
somewhere other than the public issue tracker.

## Reporting a vulnerability

**Do not open a public issue for a security problem.** An issue is indexed and
mailed to watchers within seconds, and every self-hosted instance is exposed for
as long as it takes to ship a fix.

Use GitHub's private vulnerability reporting:

**<https://github.com/bakerheit/invintelx/security/advisories/new>**

That opens a report visible only to the maintainers. It gives us a thread to ask
you questions in, and it is the same object that becomes the published advisory
once a fix exists.

The same link is on the new-issue page, under **Security vulnerability**, so you
do not have to find your way back here to use it.

If you cannot use the advisory form at all, the fallback is a public issue that
contains **no detail at all**. Blank issues are turned off, so you will be
handed the bug report form: put "Security report, requesting a private channel"
in *What happened* and leave everything optional empty. No endpoint, no version,
no reproduction — the form asks, and for this one report you should decline to
answer. A maintainer will open a private advisory and invite you to it, and
everything real goes in there.

### What to include

- **Which version.** A running instance reports it at `/api/health`. If you
  built from source, the commit.
- **How it is deployed.** Behind a reverse proxy or not, single origin or split,
  and anything non-default in `.env`.
- **What an attacker gets.** Read another tenant's stock? Forge a movement?
  Become an administrator? Impact is what decides severity, and it is the part
  a report most often leaves out.
- **How to reproduce it.** A request sequence beats a description.

### What happens next

| Step | Target |
| ---- | ------ |
| Acknowledgement that a human has read it | 5 working days |
| Assessment — is it a vulnerability, how severe, and what we intend to do | 10 working days |
| Fix released for supported versions | depends entirely on severity |

Those are targets, not a contract. InvIntelX is a small project with no on-call
rota, and saying otherwise here would be the kind of promise this policy exists
to avoid making.

A fix ships as a **new release**, never as a moved tag — a published version is
immutable, see [docs/releasing.md](docs/releasing.md). The advisory is published
once the fix is out, crediting you by whatever name you ask for, or not at all
if you would rather. If we decide a report is not a vulnerability you get the
reasoning, not silence.

### Disclosure

Please give us **90 days**, or until a fix is released, whichever comes first.

If we miss the acknowledgement target above and you have heard nothing, that
request lapses and you are free to publish. A project that does not answer has
no claim on your silence.

### Testing safely

Test against **your own instance**. Testing the hosted instance at
invintelx.org is not authorised, and neither is anything that reaches somebody
else's data.

While you stay inside that — your own deployment, no third-party data, no denial
of service, no social engineering of maintainers or users, no persistence beyond
what a proof of concept needs — the project will not pursue you for the
research, and will treat the report as made in good faith.

## Which versions get fixes

The current release. The full rule, including what happens after 1.0 and how
long a release stays supported, is in
[docs/support-policy.md](docs/support-policy.md).

## What is not a vulnerability here

Reported often enough to be worth stating, so nobody spends an evening on one:

- **Behaviour of a documented switch.** `FIRST_ADMIN_SETUP=open` hands the
  instance to the first registration — that is what it is for, and the README
  says what it costs. Leave it at the default and the takeover window does not
  exist.
- **The setup token appearing in the server log.** It is printed there
  deliberately, is replaced on the next boot, and dies the moment it has made an
  administrator. If your logs are somewhere untrusted, use `SETUP_TOKEN`.
- **Configuration you chose.** No TLS in front of the instance, `NODE_ENV` not
  set to `production` (which is what turns on the `Secure` cookie flag), a
  `SESSION_SECRET` you published. The application cannot defend a deployment
  against its own settings.
- **The rate limiter's documented trades.** Sign-in and registration buckets are
  fixed windows kept in MongoDB, so the quota belongs to the deployment rather
  than to each process. Three consequences of that shape are deliberate and
  argued in `apps/api/src/lib/rateLimit.ts`: a caller may spend a full quota at
  the end of one window and another at the start of the next, which is what
  fixed windows cost and is the intended trade for keeping a bucket one
  document; a process that has already opened buckets for 10000 distinct
  addresses inside one window refuses addresses it has not seen, because the key
  is client-influenced and something has to bound how much storage a caller can
  demand; and if MongoDB is unreachable the request fails rather than passing
  uncounted, because a control that switches itself off when the database is in
  trouble is off exactly when an attacker would want it off.
- **A missing security header with no demonstrated impact.** Show the attack it
  would have stopped.
- **Scanner output with no working proof of concept.** A tool's opinion is not a
  finding.
- **A dependency advisory with no path through InvIntelX.** Show the reachable
  call, or it is an upgrade ticket rather than a vulnerability.
- **Volumetric denial of service.** Enough traffic will exhaust any instance;
  that is what the proxy in front of it is for.

Everything else, send it.
