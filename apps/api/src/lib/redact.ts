/**
 * What never reaches a log line.
 *
 * This runs on every record the logger emits, rather than being remembered at
 * each call site, because "remember to scrub it here" is a rule that holds
 * until the first person who has not read this file adds a log line. The
 * expensive incident is the one where a session cookie sat in the log for six
 * weeks and nobody knew, so the default is redact-everything-that-looks-secret
 * and accept the occasional over-redaction.
 *
 * Two independent passes, because secrets arrive two ways:
 *
 *   - by key — `{ password: 'hunter2' }`, `req.headers.cookie`. Matched on a
 *     normalised key so `X-Api-Key`, `apiKey` and `api_key` are one rule.
 *   - by value — a Mongo URI with credentials in it, an `Authorization:
 *     Bearer …` copied into an error message, a `?token=…` in a request URL.
 *     Nothing about the *key* of those says secret; the string itself does.
 *
 * It is also what makes a log record safe to serialise at all: the output is
 * acyclic, depth-bounded and free of bigints, Buffers and functions, so
 * `JSON.stringify` on the far side cannot throw or emit a megabyte.
 */

export const REDACTED = '[redacted]';

/**
 * Substrings, not whole keys: the field is called `passwordHash` in the
 * database, `currentPassword` on the change-password form and `password` on
 * the login one, and all three are the same rule.
 */
const SECRET_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'cookie',
  'authorization',
  'apikey',
  'credential',
  'privatekey',
  'sessionid',
  'signature',
];

/**
 * Keys too short to match as substrings without swallowing innocent ones —
 * `sid` would hit `parentSid` fairly and `presidentName` absurdly.
 */
const SECRET_KEY_EXACT = new Set(['auth', 'sid', 'jwt', 'pwd', 'pass']);

/** Bounds. A log line is evidence, not a heap dump. */
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 2048;
const MAX_STACK_LENGTH = 8192;

/** `scheme://user:password@host` — the shape every Mongo URI in this app has. */
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi;

/** `Authorization: Bearer …` and its Basic sibling, wherever they got copied to. */
const AUTH_SCHEME = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * `name=value` where the name looks secret: covers both a cookie pair
 * (`invintelx_session=…`, matched on `session`) and a query parameter
 * (`?setup_token=…`). Stops at the separators that end a value in either
 * grammar, so the rest of the string survives.
 */
const SECRET_ASSIGNMENT =
  /([A-Za-z0-9_.-]*(?:token|password|secret|session|cookie|auth|apikey|api_key)[A-Za-z0-9_.-]*)=([^;&\s]+)/gi;

/** Normalised so `X-Api-Key`, `api_key` and `apiKey` are the same key. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSecretKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (SECRET_KEY_EXACT.has(normalised)) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * The value pass, applied to every string that survives the key pass — including
 * the ones that reached here inside an error message or a stack frame.
 */
export function scrubString(value: string): string {
  return value
    .replace(URI_CREDENTIALS, `$1${REDACTED}@`)
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, `$1=${REDACTED}`);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}… (${String(value.length - limit)} more characters)`;
}

/**
 * A URL with its secret query parameters removed, for the request log line.
 *
 * String surgery rather than `new URL`, because what arrives here is
 * `req.originalUrl` — a path, not an absolute URL — and inventing an origin to
 * parse it against would put a fake hostname in the log.
 */
export function redactUrl(url: string): string {
  const separator = url.indexOf('?');
  if (separator === -1) return truncate(url, MAX_STRING_LENGTH);
  const path = url.slice(0, separator);
  const query = url.slice(separator + 1);

  const scrubbed = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      return isSecretKey(decodeURIComponent(name)) ? `${name}=${REDACTED}` : pair;
    })
    .join('&');

  return truncate(`${path}?${scrubbed}`, MAX_STRING_LENGTH);
}

function isPlainish(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}

function redactError(error: Error, depth: number, seen: Set<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: error.name,
    message: scrubString(truncate(error.message, MAX_STRING_LENGTH)),
  };
  if (typeof error.stack === 'string') {
    out.stack = scrubString(truncate(error.stack, MAX_STACK_LENGTH));
  }

  /*
   * Errors in this codebase carry the interesting part on themselves - an
   * AppError's `code` and `fields`, a MongoServerError's `keyPattern`. Dropping
   * them would leave a log line that says only "something threw".
   */
  for (const key of Object.keys(error)) {
    if (key === 'stack' || key === 'message' || key === 'name') continue;
    out[key] = isSecretKey(key)
      ? REDACTED
      : walk((error as unknown as Record<string, unknown>)[key], depth + 1, seen);
  }

  if (error.cause !== undefined && error.cause !== null) {
    out.cause = walk(error.cause, depth + 1, seen);
  }

  return out;
}

function walk(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return scrubString(truncate(value, MAX_STRING_LENGTH));
    case 'number':
      // NaN and Infinity both serialise to `null`, which reads as "absent".
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'function':
      return '[function]';
    case 'symbol':
      return value.toString();
  }

  const object = value as object;

  if (depth >= MAX_DEPTH) return '[nested]';
  if (seen.has(object)) return '[circular]';

  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
  }
  if (object instanceof RegExp) return object.toString();
  if (object instanceof Error) {
    seen.add(object);
    try {
      return redactError(object, depth, seen);
    } finally {
      seen.delete(object);
    }
  }
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    return `[binary ${String(object.byteLength)} bytes]`;
  }
  if (object instanceof Map) return `[Map ${String(object.size)} entries]`;
  if (object instanceof Set) return `[Set ${String(object.size)} entries]`;

  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const kept = object.slice(0, MAX_ARRAY_ITEMS).map((item) => walk(item, depth + 1, seen));
      if (object.length > MAX_ARRAY_ITEMS) {
        kept.push(`… ${String(object.length - MAX_ARRAY_ITEMS)} more items`);
      }
      return kept;
    }

    /*
     * Anything with a class of its own - an ObjectId, a Mongo cursor - is
     * described rather than walked. Enumerating a driver internal produces
     * pages of noise, and its `toString` is what a person reading the line
     * wanted anyway.
     */
    if (!isPlainish(object)) {
      const described = describeInstance(object);
      if (described !== undefined) return described;
    }

    const out: Record<string, unknown> = {};
    const keys = Object.keys(object as Record<string, unknown>);
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      out[key] = isSecretKey(key)
        ? REDACTED
        : walk((object as Record<string, unknown>)[key], depth + 1, seen);
    }
    if (keys.length > MAX_OBJECT_KEYS) {
      out['…'] = `${String(keys.length - MAX_OBJECT_KEYS)} more keys`;
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

function describeInstance(object: object): string | undefined {
  const name = object.constructor.name;
  const asString: unknown = (object as { toString?: unknown }).toString;
  if (typeof asString !== 'function' || asString === Object.prototype.toString) return undefined;
  try {
    const text = (object as { toString(): string }).toString();
    if (text === '[object Object]') return undefined;
    return scrubString(truncate(`${name}(${text})`, MAX_STRING_LENGTH));
  } catch {
    return `[${name}]`;
  }
}

/**
 * A JSON-safe, secret-free copy of `value`.
 *
 * Never throws: a logger that can fail on the shape of what it was handed is a
 * logger that goes quiet exactly when something has gone wrong.
 */
export function redact(value: unknown): unknown {
  try {
    return walk(value, 0, new Set<object>());
  } catch {
    return '[unserialisable]';
  }
}
