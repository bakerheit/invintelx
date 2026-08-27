# Support policy

Support that is not scoped is unbounded, and unbounded support is what quietly eats a small project.
This page says which versions get fixes, how long a release stays supported, and what is somebody
else's problem. It is written for the person running their own instance.

> **Status.** Self-hosting is currently permitted and documented, but not *supported* — see the
> README. This policy is written ahead of that flip rather than after it, so the commitment has an
> edge before anyone starts relying on it. Two things are in force today regardless: the private
> disclosure route in [SECURITY.md](../SECURITY.md), and the out-of-scope list below. The response
> targets become real when the README stops saying deployment questions may go unanswered.

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

## What is in scope

- **The application.** The API, the web app, the migrations, and the `db:seed`, `db:verify` and
  `db:rebuild` commands.
- **The documented deployment.** The published image and compose stack, the environment variables
  documented in [`.env.example`](../.env.example), and the documented
  [backup and restore](backup-and-restore.md) and upgrade procedures — including the case where you
  followed them exactly and got a different result.
- **Documentation that is wrong.** A page that tells you to do something that does not work is a
  bug, and a more annoying one than most.

## What is out of scope

Not hostility — just the line that keeps the list above answerable.

- **Your reverse proxy, TLS, DNS and firewall.** "It 502s behind my nginx" is not a product bug
  until the same request fails against the API directly. InvIntelX needs no configuration to sit
  behind a proxy; if it needs some at your site, that is your topology.
- **Operating MongoDB.** Sizing, storage, replica set administration beyond what the compose stack
  does for you, and backups you took some other way than the documented one.
- **Container orchestration.** No Kubernetes manifests, Helm charts, Swarm stacks or systemd units
  ship from here, and none are supported. Patches that make them easier are welcome; questions about
  yours are not answerable.
- **Modified builds.** The AGPL guarantees your right to change the code. It does not oblige anyone
  to debug the result. Reproduce against a stock release first.
- **Topologies the docs say are not wired up.** More than one API instance behind a load balancer
  — the rate limiter is per-process — and serving the web app and the API from two different
  origins, which the README describes and explicitly does not support.
- **Configurations documented as a bad idea.** `FIRST_ADMIN_SETUP=open` on anything that is not a
  public sign-up deployment, `NODE_ENV` left unset in production, a leaked `SESSION_SECRET`.
- **Versions outside the table above.**
- **Performance tuning** for your hardware or your dataset, **data migration from another system**,
  integration work, and training.

## Where to send what

| You have | Where it goes |
| -------- | ------------- |
| A security vulnerability | [SECURITY.md](../SECURITY.md). Never a public issue. |
| A bug in a supported version | A GitHub issue: the version from `/api/health`, how it is deployed, and a reproduction |
| A question about running it | A GitHub issue, said plainly to be a question. It may go unanswered — see the status note |
| A feature request | A GitHub issue. Out of scope for *support*, in scope for the roadmap |

Say which one you are on — the hosted instance or your own deployment — so expectations match on
both sides.

## There is no commercial support

No paid tier, no SLA, no response guarantee beyond the targets in
[SECURITY.md](../SECURITY.md). If your organisation needs one, ask: the same conversation that makes
a commercial licence possible can cover support.
