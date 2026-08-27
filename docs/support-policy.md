# Support policy

Support that is not scoped is unbounded, and unbounded support is what quietly eats a small project.
This page says which versions get fixes, how long a release stays supported, and what is somebody
else's problem. It is written for the person running their own instance.

> **Status.** invintelx.org is the only *supported* deployment — the README says so and this page
> does not contradict it. Self-hosting is permitted and documented; running it is allowed, operating
> it is currently your problem. This policy is written ahead of that changing rather than after it,
> so the commitment has an edge before anyone starts relying on it.
>
> The distinction the README draws is the one that matters most here, and it is not "hosted reports
> count, self-hosted reports do not". **A bug in InvIntelX is welcome wherever you noticed it**,
> self-hosted included. A problem with your own cluster, proxy or TLS is not a bug in InvIntelX and
> may go unanswered. That is the same line the in-scope and out-of-scope lists below draw, in more
> detail.
>
> Two things are in force today regardless of any of that: the private disclosure route in
> [SECURITY.md](../SECURITY.md), and the out-of-scope list below. The response targets are the part
> written ahead of itself — they describe the intent, and they become a commitment when this project
> stops saying a self-hosting question may go unanswered.

## Which versions get fixes

"Supported" means a report against that version will be looked at, and a fix, if there is one, will
be released. It does not mean a fix will be backported onto the tag you happen to be pinned to.

**Before 1.0.0 — where the project is now:**

| Version | Gets fixes |
| ------- | ---------- |
| The most recent release | Yes — bugs and security |
| Anything older | No |

One supported version at a time. There are no long-lived `0.x` branches and nothing is backported;
if you are behind, the fix is to move forward. That is affordable for a project this size and
maintaining a second line is not.

**From 1.0.0 onwards:**

| Version | Gets fixes | For how long |
| ------- | ---------- | ------------ |
| Current MINOR series | Bugs and security | Until the next MINOR is released |
| Previous MINOR series | Security only | 90 days after its successor was released |
| Previous MAJOR, final MINOR | Security only | 180 days after the new MAJOR was released |
| Anything else | No | — |

Within a series you are expected to take the newest PATCH. A bug that is already fixed in
`1.4.2` is not open against `1.4.0`; upgrading the patch is the answer, and by the rules in
[releasing.md](releasing.md) a patch release adds no configuration and no new data shape, so taking
it is cheap by construction.

A fix is always a **new version**. Tags are immutable here — a released version is never rebuilt or
moved, so "we patched the tag you are on" is not a thing that will ever happen.

Which makes "move forward" the answer to most of this page, so it had better be a route rather than
an instruction. It is: [upgrading.md](upgrading.md) says you may skip versions within a major and
not across one — read `0.x` → `0.y` as the major rule while this project is pre-`1.0.0` — and that
claim has a test behind it rather than a promise. However far behind you are, getting to a supported
version is a bounded number of steps that somebody has checked.

## What is in scope

- **The application.** The API, the web app, the migrations, and the `db:seed`, `db:verify` and
  `db:rebuild` commands.
- **The documented deployment.** Running it the way the README says to run it, the environment
  variables documented in [`.env.example`](../.env.example), and the documented
  [backup and restore](backup-and-restore.md) and [upgrade](upgrading.md) procedures — including
  the case where you followed them exactly and got a different result. There is no published
  container image yet; when there is one it is in scope, and until then a question about the
  image you built is a question about your build.
- **Documentation that is wrong.** A page that tells you to do something that does not work is a
  bug, and a more annoying one than most.

## What is out of scope

Not hostility — just the line that keeps the list above answerable.

- **Your reverse proxy, TLS, DNS and firewall.** "It 502s behind my nginx" is not a product bug
  until the same request fails against the API directly. InvIntelX needs no configuration to sit
  behind a proxy; if it needs some at your site, that is your topology.
- **Operating MongoDB.** Sizing, storage and replica set administration. `docker-compose.yml`
  starts a MongoDB for *development* and nothing more; whatever you run in production is yours to
  operate. Backups you took some other way than the documented one are yours too.
- **Container orchestration.** No Kubernetes manifests, Helm charts, Swarm stacks or systemd units
  ship from here, and none are supported. Patches that make them easier are welcome; questions about
  yours are not answerable.
- **Modified builds.** The AGPL guarantees your right to change the code. It does not oblige anyone
  to debug the result. Reproduce against a stock release first.
- **Topologies the docs say are not wired up.** Serving the web app and the API from two different
  origins: the README describes it, says it needs `WEB_ORIGIN` and `SameSite=None; Secure` cookies,
  and says that is not currently wired up. Also more than one API instance behind a load balancer —
  the rate limiter no longer splits its quota per process, which removed the known obstacle, but
  removing an obstacle is not the same as having run the topology, and nothing here has.
- **Configurations documented as a bad idea.** `FIRST_ADMIN_SETUP=open` on anything that is not a
  public sign-up deployment, `NODE_ENV` left unset in production, a leaked `SESSION_SECRET`.
- **Versions outside the table above.**
- **Performance tuning** for your hardware or your dataset, **data migration from another system**,
  integration work, and training.

## Where to send what

| You have | Where it goes |
| -------- | ------------- |
| A security vulnerability | [SECURITY.md](../SECURITY.md), which is the **Security vulnerability** link on the new-issue page. Never an ordinary public issue. |
| A bug in a supported version | The **Bug report** form. It asks which deployment, the version from `/api/health`, and what happened — the three things a triage would otherwise have to ask for |
| A feature request | The **Feature request** form. Out of scope for *support*, in scope for the roadmap |
| A question about running your own instance | Not an issue form. The new-issue page links the README's self-hosting section instead, because that is where the answer is if there is one. It may go unanswered — see the status note |

Blank issues are turned off, so every one of these arrives having said which deployment it is about.
That question is the one doing the work: answer it honestly rather than tactically. "My own
self-hosted deployment" does not get an issue closed — it gets it read with the right question in
mind.

## There is no commercial support

No paid tier, no SLA, no response guarantee beyond the targets in
[SECURITY.md](../SECURITY.md). If your organisation needs one, ask: the same conversation that makes
a commercial licence possible can cover support.
