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
});
