import { describe, expect, it } from 'vitest';
import { REDACTED, isSecretKey, redact, redactUrl, scrubString } from './redact.js';

/**
 * The tests for the promise the ticket actually made: no password, session
 * token or cookie reaches a log line. Everything here is a value that really
 * occurs in this codebase - the login body, `req.headers`, a Mongo URI, an
 * AppError with `fields` on it - rather than an invented one.
 *
 * No database and no logger: this is the pure half, and it is the half that has
 * to be right, because every other test of logging assumes it.
 */

describe('keys that are secret', () => {
  it('matches the password fields this app really has', () => {
    for (const key of ['password', 'currentPassword', 'passwordHash', 'PASSWORD']) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it('ignores punctuation and case, so one rule covers every spelling', () => {
    for (const key of ['api_key', 'apiKey', 'X-Api-Key', 'API-KEY']) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it('covers cookies, tokens and authorization headers', () => {
    for (const key of ['cookie', 'set-cookie', 'Authorization', 'setupToken', 'tokenHash', 'sid']) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  it('leaves ordinary fields alone', () => {
    // Over-redaction is cheap but not free: a log with `sku` blanked out is a
    // log nobody can use.
    for (const key of ['sku', 'email', 'name', 'quantity', 'actorName', 'president', 'keyboard']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe('secrets found by their value rather than their key', () => {
  it('strips credentials out of a connection string', () => {
    expect(scrubString('mongodb://appuser:s3cret@cluster0.mongodb.net/invintelx')).toBe(
      `mongodb://${REDACTED}@cluster0.mongodb.net/invintelx`,
    );
  });

  it('leaves a connection string without credentials intact', () => {
    const uri = 'mongodb://localhost:27017/invintelx?replicaSet=rs0';
    expect(scrubString(uri)).toBe(uri);
  });

  it('strips a bearer token that got copied into an error message', () => {
    expect(scrubString('upstream said 401 for Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe(
      `upstream said 401 for Bearer ${REDACTED}`,
    );
  });

  it('strips the session cookie out of a raw cookie header', () => {
    const scrubbed = scrubString('theme=dark; invintelx_session=8fQ2mVx0; sidebar=open');
    expect(scrubbed).toContain('theme=dark');
    expect(scrubbed).toContain('sidebar=open');
    expect(scrubbed).not.toContain('8fQ2mVx0');
  });

  /*
   * INVX-116 f-6. A secret that was serialised before it got here has no key
   * left for the key pass to match, and the `name=value` rule wants an equals
   * sign. These are the shapes it actually arrives in.
   */
  describe('a secret that had already been serialised', () => {
    it('strips a password out of a stringified body inside an error message', () => {
      const scrubbed = scrubString(
        'upstream rejected {"email":"a@b.c","password":"hunter2"} with 422',
      );
      expect(scrubbed).not.toContain('hunter2');
      expect(scrubbed).toContain('a@b.c');
      // Still parseable: the value is replaced, the quotes around it are not.
      expect(scrubbed).toContain(`"password":"${REDACTED}"`);
    });

    it('strips a token written as prose with a colon', () => {
      expect(scrubString('refresh failed, setup_token: abc123def')).toBe(
        `refresh failed, setup_token: ${REDACTED}`,
      );
    });

    it("strips a class's own toString dump of its fields", () => {
      const scrubbed = scrubString("Session { id: 'abc', sessionToken: '8fQ2mVx0' }");
      expect(scrubbed).not.toContain('8fQ2mVx0');
      expect(scrubbed).toContain("id: 'abc'");
    });

    it('leaves a host:port alone, which is why the prose rule wants whitespace', () => {
      const line = 'connect ECONNREFUSED tokens.internal:8443';
      expect(scrubString(line)).toBe(line);
    });

    it('leaves a stack frame in a file whose name looks secret alone', () => {
      const frame = '    at readToken (/app/apps/api/src/lib/token.js:12:5)';
      expect(scrubString(frame)).toBe(frame);
    });

    it('does not redact an authorization header twice', () => {
      // AUTH_SCHEME has already run by the time the colon rule sees this.
      expect(scrubString('authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe(
        `authorization: Bearer ${REDACTED}`,
      );
    });
  });
});

describe('redacting a request URL', () => {
  it('keeps a query that holds nothing secret', () => {
    expect(redactUrl('/api/items?page=2&pageSize=25')).toBe('/api/items?page=2&pageSize=25');
  });

  it('blanks a secret parameter and keeps the rest of the line readable', () => {
    expect(redactUrl('/api/auth/register?setup_token=abc123&email=x@y.z')).toBe(
      `/api/auth/register?setup_token=${REDACTED}&email=x@y.z`,
    );
  });

  it('does not invent an origin for a path', () => {
    expect(redactUrl('/api/items/507f1f77bcf86cd799439011')).toBe(
      '/api/items/507f1f77bcf86cd799439011',
    );
  });

  /*
   * INVX-116 f-5. `decodeURIComponent('%zz')` is a `URIError`, and this is
   * called from a `res` event listener, so the throw is an `uncaughtException`
   * rather than a 500 - unauthenticated, on every route. Each of these is a
   * request somebody can send today.
   */
  describe('a query string that does not decode', () => {
    it('does not throw on a malformed escape', () => {
      expect(() => redactUrl('/?%zz=1')).not.toThrow();
    });

    it('does not throw on a bare trailing percent', () => {
      expect(() => redactUrl('/api/items?page%=2')).not.toThrow();
    });

    it('does not throw on a lone high surrogate escape', () => {
      expect(() => redactUrl('/?%ED%A0%80=1')).not.toThrow();
    });

    it('redacts what it cannot decode, rather than passing it through', () => {
      // The file's policy is to over-redact: a name that cannot be shown to be
      // safe is treated as though it were secret.
      expect(redactUrl('/?%zz=1')).toBe(`/?%zz=${REDACTED}`);
    });

    it('keeps the readable parameters of a request that has one bad one', () => {
      const line = redactUrl('/api/items?page=2&%zz=1&pageSize=25');
      expect(line).toContain('page=2');
      expect(line).toContain('pageSize=25');
      expect(line).toContain(`%zz=${REDACTED}`);
    });

    it('still redacts an encoded secret name that does decode', () => {
      // `setup%5Ftoken` is `setup_token`; the decode exists so this is caught.
      expect(redactUrl('/api/auth/register?setup%5Ftoken=abc123')).toBe(
        `/api/auth/register?setup%5Ftoken=${REDACTED}`,
      );
    });
  });
});

describe('redacting a whole record', () => {
  it('removes a login body', () => {
    const record = redact({ body: { email: 'a@b.c', password: 'hunter2' } }) as {
      body: Record<string, unknown>;
    };
    expect(record.body.email).toBe('a@b.c');
    expect(record.body.password).toBe(REDACTED);
  });

  it('removes the cookie and authorization headers but keeps the rest', () => {
    const record = redact({
      headers: {
        'content-type': 'application/json',
        cookie: 'invintelx_session=8fQ2mVx0',
        authorization: 'Bearer abc',
        'user-agent': 'Mozilla/5.0',
      },
    }) as { headers: Record<string, unknown> };

    expect(record.headers['content-type']).toBe('application/json');
    expect(record.headers['user-agent']).toBe('Mozilla/5.0');
    expect(record.headers.cookie).toBe(REDACTED);
    expect(record.headers.authorization).toBe(REDACTED);
  });

  it('reaches secrets nested inside arrays', () => {
    const record = redact({ users: [{ email: 'a@b.c', passwordHash: '$argon2id$v=19$...' }] }) as {
      users: { passwordHash: string }[];
    };
    expect(record.users[0]?.passwordHash).toBe(REDACTED);
  });

  it('turns an Error into a serialisable object, scrubbing its message', () => {
    const error = new Error('could not reach mongodb://user:pw@host/db');
    const record = redact({ err: error }) as { err: Record<string, unknown> };

    expect(record.err.type).toBe('Error');
    expect(record.err.message).toBe(`could not reach mongodb://${REDACTED}@host/db`);
    expect(typeof record.err.stack).toBe('string');
  });

  it('keeps the fields an AppError carries, because they are the useful part', () => {
    class Fake extends Error {
      constructor() {
        super('conflict');
        this.name = 'ConflictError';
      }
      readonly status = 409;
      readonly code = 'conflict';
      readonly token = 'should not survive';
    }

    const record = redact({ err: new Fake() }) as { err: Record<string, unknown> };
    expect(record.err.status).toBe(409);
    expect(record.err.code).toBe('conflict');
    expect(record.err.token).toBe(REDACTED);
  });

  it('survives a cycle rather than blowing the stack', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redact(a)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('produces something JSON.stringify cannot fail on', () => {
    const awkward = {
      when: new Date('2026-08-27T03:54:23.326Z'),
      big: 10n,
      blob: Buffer.from('binary'),
      fn: () => 'no',
      seen: new Set([1, 2]),
      nan: Number.NaN,
    };

    const json = JSON.stringify(redact(awkward));
    expect(json).toContain('2026-08-27T03:54:23.326Z');
    expect(json).toContain('10n');
    expect(json).toContain('[binary 6 bytes]');
    expect(json).toContain('[function]');
    expect(json).toContain('[Set 2 entries]');
    expect(json).toContain('NaN');
  });

  it('stops descending rather than walking an unbounded structure', () => {
    let deep: Record<string, unknown> = { bottom: true };
    for (let i = 0; i < 12; i += 1) deep = { down: deep };

    expect(JSON.stringify(redact(deep))).toContain('[nested]');
  });

  it('truncates a string long enough to be a payload rather than a message', () => {
    const record = redact({ note: 'x'.repeat(5000) }) as { note: string };
    expect(record.note.length).toBeLessThan(3000);
    expect(record.note).toContain('more characters');
  });

  /*
   * INVX-116 f-7. The file promises `redact` never throws, and the outer catch
   * does keep that - but it keeps it by returning `[unserialisable]` for the
   * *whole record*. One awkward field must not cost the other twenty.
   */
  describe('an object shaped so that describing it would throw', () => {
    it('keeps the rest of the record when one field has no constructor', () => {
      // Not plainish - its prototype is not `Object.prototype` - but its
      // prototype chain carries no `constructor` either.
      const orphan = Object.create(Object.create(null)) as Record<string, unknown>;
      orphan.sku = 'ABC-1';

      const record = redact({ event: 'movement', quantity: 4, subject: orphan }) as Record<
        string,
        unknown
      >;
      expect(record.event).toBe('movement');
      expect(record.quantity).toBe(4);
      expect(record.subject).toEqual({ sku: 'ABC-1' });
    });

    it('keeps the rest of the record when a field throws from toString', () => {
      class Hostile {
        toString(): string {
          throw new Error('no');
        }
      }

      const record = redact({ event: 'movement', subject: new Hostile() }) as Record<
        string,
        unknown
      >;
      expect(record.event).toBe('movement');
      expect(record.subject).toBe('[Hostile]');
    });

    it('describes an instance whose class name looks secret by name only', () => {
      class SessionToken {
        constructor(readonly value: string) {}
        toString(): string {
          return this.value;
        }
      }

      const record = redact({ held: new SessionToken('8fQ2mVx0') }) as Record<string, unknown>;
      expect(record.held).toBe('[SessionToken]');
      expect(JSON.stringify(record)).not.toContain('8fQ2mVx0');
    });

    it('bounds the fields it copies off an error, like every other container', () => {
      const error = new Error('too much');
      for (let i = 0; i < 150; i += 1) {
        (error as unknown as Record<string, unknown>)[`field${String(i)}`] = i;
      }

      const record = redact({ err: error }) as { err: Record<string, unknown> };
      expect(Object.keys(record.err).length).toBeLessThan(150);
      expect(record.err['…']).toContain('more keys');
    });
  });
});
