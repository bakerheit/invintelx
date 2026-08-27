import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { envSchema, type Env } from './envSchema.js';

/*
 * Generates the per-variable half of docs/configuration.md from `envSchema`.
 *
 * The point is that the reference cannot drift. Three things make that true:
 *
 *   - `CONFIG_DOCS` is a `Record<keyof Env, ...>`, so adding a variable to the
 *     schema fails the typecheck until somebody writes down what it does.
 *   - The facts - required or not, the default, the accepted range - are read
 *     off the schema rather than retyped.
 *   - The boot messages are obtained by actually parsing a bad value, so the
 *     page quotes what the process really prints and not what somebody
 *     remembered it printing.
 *
 * The prose around the generated block is hand-written and stays that way:
 * "rotate this knowingly" is not a fact a schema holds.
 */

/** The prose a schema cannot know, kept next to the schema so it moves with it. */
interface VarDoc {
  /** What the variable does, in terms of the running instance. Markdown. */
  does: string;
  /**
   * Values to feed the field so the page can quote the real rejection message.
   * A required variable is additionally probed with "unset". A probe that the
   * schema accepts is a bug in this table and throws.
   */
  rejects: string[];
  /**
   * What a wrong-but-accepted value looks like from the outside - the failure
   * that reaches an operator as a symptom rather than as a boot error.
   */
  accepted: string;
}

const CONFIG_DOCS: Record<keyof Env, VarDoc> = {
  NODE_ENV: {
    does:
      'Selects the production behaviours, and is the only variable that does. `production` sets ' +
      '`Secure` on the session cookie, tells Express to trust one hop of `X-Forwarded-For` so the ' +
      'sign-in rate limiter keys on the client rather than on your reverse proxy, and turns a ' +
      'missing web build into a warning in the log.\n\n' +
      'Use `production` for anything that is not a developer machine. `test` is for the test suite ' +
      'and switches the rate limiter off.',
    rejects: ['prod'],
    accepted:
      'Left at `development` on a real deployment, the instance works — which is the problem. The ' +
      'session cookie loses `Secure`, so a browser will send it over plain HTTP; every request ' +
      'looks like it came from the proxy, so one client can spend the whole sign-in rate limit for ' +
      'everybody; and an instance with no web build says nothing about it. Nothing warns you, ' +
      'because from inside the process this is a perfectly ordinary configuration.',
  },
  PORT: {
    does:
      'The port the API listens on. One process answers both `/api` and the web app, so this is ' +
      'the only port InvIntelX opens.',
    rejects: ['0', '70000', 'not-a-port'],
    accepted:
      'A port already in use is an `EADDRINUSE` crash at boot, which is loud enough. The quiet one ' +
      'is changing this and not changing the reverse proxy: the proxy keeps dialling 3001, every ' +
      'request 502s, and the API log says it is listening perfectly happily.',
  },
  MONGODB_URI: {
    does:
      'How the driver reaches MongoDB. **A replica set is required, not a preference** — a stock ' +
      'movement and the on-hand figure it changes are written in one transaction, and MongoDB only ' +
      'offers transactions on a replica set.\n\n' +
      'Credentials belong in the URI rather than on a command line, where they end up in shell ' +
      'history and in `docker inspect`.',
    rejects: [''],
    accepted:
      'A URI that resolves but is not a replica set gets all the way through boot, serves sign-in ' +
      'and the item screens, and fails the first time anybody moves stock — an `IllegalOperation` ' +
      'about transaction numbers, from a deployment that has looked healthy for hours.\n\n' +
      'The database name in the URI path is **ignored**: `MONGODB_DB` decides that, after the ' +
      'connection is made. A URI ending `/acme` with `MONGODB_DB` unset writes to `invintelx`, and ' +
      'an operator inspecting `acme` finds an empty database and no error anywhere.',
  },
  MONGODB_DB: {
    does:
      'Which database on that server. Applied after connecting, which is why it overrides the ' +
      "database named in `MONGODB_URI`'s path rather than agreeing with it.",
    rejects: [''],
    accepted:
      'Point it at a name that does not exist and MongoDB makes one. The instance is not broken, ' +
      'it is *empty*: no accounts, no items, and a fresh setup token in the log offering the ' +
      'instance to whoever reads it. The same mistake ruins a restore — dump under one name, run ' +
      'under another, and nothing you restored is there.',
  },
  SESSION_SECRET: {
    does:
      'Generate one with `openssl rand -base64 32`, inject it as a real environment variable, and ' +
      'keep it out of version control.\n\n' +
      '> **Nothing in the running code reads this value today.** Sessions are 256-bit random ' +
      'tokens stored as a SHA-256 hash; nothing is signed, and `cookie-parser` is mounted without ' +
      'a secret. So changing it signs nobody out, and two instances sharing one database can hold ' +
      'different values and still accept each other’s sessions. It is required at boot so that a ' +
      'deployment already has one on the day something starts signing with it — at which point ' +
      'rotation *will* end every session. Do not build a habit of rotating it casually on the ' +
      'strength of it being free right now.\n\n' +
      'To end every session deliberately — the thing operators actually reach for this variable ' +
      'to do — empty the `sessions` collection. Everyone is signed out at their next request.',
    rejects: ['hunter2'],
    accepted:
      'Anything 32 characters or longer is accepted, including 32 spaces and the placeholder in ' +
      '`.env.example`. Nothing checks entropy, nothing detects the same secret reused across two ' +
      'instances, and — because nothing reads it — nothing you can observe from outside tells you ' +
      'it is weak. Treat the boot check as a length check and not as a review.',
  },
  WEB_ORIGIN: {
    does:
      'The single origin allowed to make credentialed cross-origin calls to `/api`.\n\n' +
      'In the deployment this project documents — one process serving both the API and the web ' +
      'app — the browser is always same-origin and **this value is never consulted**. It matters ' +
      'only if the web assets are served from a different host or port to the API.',
    rejects: ['invintelx.example.com'],
    accepted:
      'In a single-origin deployment: no effect whatsoever, including when it is left at the ' +
      'development default. It being wrong is not a problem you can have.\n\n' +
      'In a split-origin deployment it is wrong silently, and reaches you as unexplained sign-in ' +
      'failures. The browser blocks every `/api` call, so the form appears to do nothing, while ' +
      'the API access log shows the requests arriving and succeeding. The match is an exact string ' +
      'comparison against the `Origin` header: `https://acme.example` does not admit ' +
      '`https://www.acme.example`, `http://` does not admit `https://`, and a trailing slash — ' +
      'which the schema accepts and a browser never sends — never matches anything.\n\n' +
      'Fixing `WEB_ORIGIN` is also not enough on its own to make that topology work: the session ' +
      'cookie is `SameSite=Lax`, so a cross-origin sign-in still does not stick. Split origins ' +
      'need cookies marked `SameSite=None` and `Secure`, which is not wired up. Serve both halves ' +
      'from one origin and none of this applies.',
  },
  WEB_DIST: {
    does:
      'Where the built web app is. Unset, the API looks next door in `apps/web/dist`, which is ' +
      'where `pnpm build` puts it — so an ordinary build needs nothing here. Set it when the ' +
      'layout differs, such as an image that copies the assets somewhere else.\n\n' +
      'Serving nothing at all is a valid choice: leave this unset, do not build the web app, and ' +
      'put a proxy in front that serves the assets itself. The API then answers `/api` only and ' +
      'says so in the log.',
    rejects: [''],
    accepted:
      'A directory that exists but holds no `index.html` is a **boot failure**, on purpose — an ' +
      'instance that 404s every page is not a useful thing to have started. The accepted-but-wrong ' +
      'case is subtler: point it at a stale build and everything works, at the previous version. ' +
      '`/api/health` reports the API version, and there is nothing anywhere that reports the ' +
      'version of the assets, so a half-finished upgrade looks entirely healthy.',
  },
  FIRST_ADMIN_SETUP: {
    does:
      'How this instance gets its first administrator.\n\n' +
      '`token` (the default) mints a setup token at every boot while the instance has no accounts ' +
      'and prints it to the log. Registration will not create an administrator without it, so ' +
      'deploying the instance and claiming it are two separate acts.\n\n' +
      '`open` hands the instance to the first account that registers, with no token. That is the ' +
      'right answer for a public sign-up product and the wrong one for everything else.',
    rejects: ['open-ish', 'true'],
    accepted:
      '`open` on anything reachable from the internet means whoever finds it first owns your ' +
      'inventory system. Nothing about the instance looks different before it happens, and once it ' +
      'has, the product offers no way to undo it — the takeover is a legitimate first ' +
      'registration. The boot log is the only warning, and it is printed once.',
  },
  SETUP_TOKEN: {
    does:
      'Pins the setup token instead of minting one, for deploys where injecting a secret is easier ' +
      'than reading a container log. Stored hashed, exactly like a minted one.',
    rejects: ['too-short'],
    accepted:
      'It is **ignored once the instance has an account**, silently — so setting it to get back ' +
      'into an instance whose administrator has been lost does nothing at all, and the boot log ' +
      'will not mention it. It is also read only at boot: changing it in `.env` does nothing until ' +
      'the process restarts.',
  },
};

const GENERATED_START = '<!-- generated from apps/api/src/envSchema.ts by `pnpm docs:config` -->';
const GENERATED_END = '<!-- end generated -->';

/** docs/configuration.md, resolved from this file rather than from the cwd. */
export const CONFIG_REFERENCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/configuration.md',
);

interface Facts {
  /** The schema with `.default()` / `.optional()` taken off. */
  inner: z.ZodTypeAny;
  /** No default and not optional: leaving it out stops the boot. */
  required: boolean;
  /** The sentence that opens the variable's section. */
  requirement: string;
}

/** Unwraps `.default()` and `.optional()` to whatever is underneath. */
function facts(field: z.ZodTypeAny): Facts {
  if (field instanceof z.ZodDefault) {
    const value = field._def.defaultValue() as unknown;
    return {
      inner: field.removeDefault() as z.ZodTypeAny,
      required: false,
      requirement: `**Optional.** Defaults to \`${String(value)}\`.`,
    };
  }
  if (field instanceof z.ZodOptional) {
    return {
      inner: field.unwrap() as z.ZodTypeAny,
      required: false,
      requirement: '**Optional.** Unset by default.',
    };
  }
  return { inner: field, required: true, requirement: '**Required.**' };
}

/** A one-clause description of what the field accepts, read off its checks. */
function shape(inner: z.ZodTypeAny): string {
  if (inner instanceof z.ZodEnum) {
    const options = (inner.options as string[]).map((o) => `\`${o}\``);
    return `One of ${options.join(', ')}.`;
  }

  if (inner instanceof z.ZodNumber) {
    const int = inner._def.checks.some((c) => c.kind === 'int');
    const min = inner._def.checks.find((c) => c.kind === 'min');
    const max = inner._def.checks.find((c) => c.kind === 'max');
    const range =
      min && max && min.kind === 'min' && max.kind === 'max'
        ? ` ${min.value}–${max.value}.`
        : min && min.kind === 'min'
          ? ` ${min.value} or greater.`
          : '.';
    return `${int ? 'Integer' : 'Number'}${range}`;
  }

  if (inner instanceof z.ZodString) {
    const url = inner._def.checks.some((c) => c.kind === 'url');
    if (url) return 'A URL, including the scheme.';
    const min = inner._def.checks.find((c) => c.kind === 'min');
    if (min && min.kind === 'min') {
      if (min.value === 1) return 'A non-empty string.';
      return `A string of at least ${min.value} characters.`;
    }
    return 'A string.';
  }

  // Unreachable today. It exists so a new kind of variable is a loud failure
  // rather than a page that quietly says nothing about it.
  throw new Error(`configReference: no shape description for ${inner._def.typeName}`);
}

/** Words, except that an inline code span stays whole however it is spaced. */
function tokenize(paragraph: string): string[] {
  const tokens: string[] = [];
  let open = false;

  for (const word of paragraph.split(/\s+/)) {
    const balanced = (word.match(/`/g) ?? []).length % 2 === 0;
    if (open) {
      tokens[tokens.length - 1] = `${tokens[tokens.length - 1] ?? ''} ${word}`;
    } else {
      tokens.push(word);
    }
    if (!balanced) open = !open;
  }

  return tokens;
}

/**
 * Greedy wrap at the width prettier is configured for, so the generated block
 * reviews like the hand-written pages around it instead of as one line per
 * paragraph. Carries a `> ` blockquote prefix onto every line of a quote.
 *
 * An inline code span is one token however many spaces are inside it: a line
 * break inside backticks renders fine but reads as a mistake in the diff, and
 * whoever writes the next variable's prose should not have to think about it.
 */
function wrap(text: string, width = 100): string {
  return text
    .split('\n\n')
    .map((paragraph) => {
      const quoted = paragraph.startsWith('> ');
      const prefix = quoted ? '> ' : '';
      const words = tokenize(quoted ? paragraph.slice(2) : paragraph);
      const lines: string[] = [];
      let line = '';

      for (const word of words) {
        const candidate = line === '' ? word : `${line} ${word}`;
        if (prefix.length + candidate.length > width && line !== '') {
          lines.push(prefix + line);
          line = word;
        } else {
          line = candidate;
        }
      }
      if (line !== '') lines.push(prefix + line);

      return lines.join('\n');
    })
    .join('\n\n');
}

/** The real message, obtained by parsing the bad value rather than recalling it. */
function rejectionFor(name: string, field: z.ZodTypeAny, value: string | undefined): string {
  const result = field.safeParse(value);
  if (result.success) {
    throw new Error(
      `configReference: ${name} lists ${JSON.stringify(value)} as rejected, but the schema ` +
        `accepts it. The page would have quoted an error that never happens.`,
    );
  }
  const message = result.error.issues.map((i) => i.message).join('; ');
  const label = value === undefined ? 'unset' : `\`${name}=${value}\``;
  return `- ${label} → \`${message}\``;
}

/** The generated half of docs/configuration.md, markers included. */
export function renderConfigReference(): string {
  const sections = Object.keys(envSchema.shape).map((name) => {
    const field = envSchema.shape[name as keyof Env] as z.ZodTypeAny;
    const doc = CONFIG_DOCS[name as keyof Env];
    const { inner, required, requirement } = facts(field);

    // A required variable is always probed with "unset" first: that is the
    // message an operator who forgot it entirely will be looking at.
    const probes: (string | undefined)[] = [...(required ? [undefined] : []), ...doc.rejects];

    return [
      `### \`${name}\``,
      '',
      wrap(`${requirement} ${shape(inner)}`),
      '',
      wrap(doc.does),
      '',
      '**Refused at boot**',
      '',
      probes.map((probe) => rejectionFor(name, field, probe)).join('\n'),
      '',
      '**Accepted, and wrong**',
      '',
      wrap(doc.accepted),
    ].join('\n');
  });

  return [GENERATED_START, '', sections.join('\n\n'), '', GENERATED_END].join('\n');
}

/** Where the generated block sits in `page`. Throws if the markers are gone. */
function bounds(page: string): { start: number; end: number } {
  const start = page.indexOf(GENERATED_START);
  const end = page.indexOf(GENERATED_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `configReference: no generated block found. The opening marker is ${GENERATED_START}`,
    );
  }
  return { start, end: end + GENERATED_END.length };
}

/** The generated block as it currently stands in `page`, markers included. */
export function extractGenerated(page: string): string {
  const { start, end } = bounds(page);
  return page.slice(start, end);
}

/**
 * Replaces the generated block in `page`, leaving the hand-written prose alone.
 *
 * Index arithmetic rather than `String.replace`, which reads `$&` and friends
 * out of the replacement - and the replacement here is arbitrary prose.
 */
export function spliceGenerated(page: string, block: string): string {
  const { start, end } = bounds(page);
  return page.slice(0, start) + block + page.slice(end);
}

/** Rewrites the generated block of docs/configuration.md in place. */
export function writeConfigReference(): void {
  const page = readFileSync(CONFIG_REFERENCE_PATH, 'utf8');
  writeFileSync(CONFIG_REFERENCE_PATH, spliceGenerated(page, renderConfigReference()));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeConfigReference();
  console.log(`[invintelx] rewrote ${CONFIG_REFERENCE_PATH}`);
}
