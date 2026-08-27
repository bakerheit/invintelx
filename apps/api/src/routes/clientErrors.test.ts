import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * The half of error tracking the server cannot see on its own.
 *
 * A crash in the browser leaves no trace here: the request that caused it
 * returned 200, and the stack exists only on a machine nobody operating this
 * app can reach. These tests are about that report arriving, being bounded, and
 * being scrubbed before it becomes a log line - the last of which matters most,
 * because the payload comes from outside.
 *
 * No mongod: this route touches no collection.
 */
let app: Express;
let logging: typeof import('../lib/logger.js');

const lines: string[] = [];

function records(): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function exceptionLine(): Record<string, unknown> | undefined {
  return records().find((record) => record.event === 'exception');
}

const REPORT = {
  kind: 'error' as const,
  message: 'Cannot read properties of undefined (reading map)',
  name: 'TypeError',
  stack: 'TypeError: Cannot read properties of undefined\n    at ItemsPage (index-B7f3Kq2x.js:1:2)',
  url: 'https://invintelx.org/items',
};

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  process.env.LOG_LEVEL = 'debug';
  process.env.LOG_FORMAT = 'json';

  logging = await import('../lib/logger.js');
  const { createApp } = await import('../app.js');
  app = createApp();
});

afterEach(() => {
  logging.setLogDestination();
  lines.length = 0;
});

afterAll(() => {
  delete process.env.LOG_LEVEL;
  delete process.env.LOG_FORMAT;
});

function capture(): void {
  logging.setLogDestination((line) => lines.push(line));
}

describe('reporting a browser error', () => {
  it('accepts one and says nothing back', async () => {
    // The browser is already broken. Do not make it parse a response body.
    await request(app).post('/api/client-errors').send(REPORT).expect(204);
  });

  it('takes a report from a browser with no session', async () => {
    // The errors most worth hearing about are the ones that stopped somebody
    // signing in. Requiring a session would filter out exactly those.
    await request(app).post('/api/client-errors').send(REPORT).expect(204);
  });

  it('becomes the same exception event an API failure produces', async () => {
    capture();
    await request(app).post('/api/client-errors').send(REPORT).expect(204);

    const line = exceptionLine();
    expect(line).toMatchObject({
      event: 'exception',
      side: 'web',
      kind: 'error',
      url: 'https://invintelx.org/items',
      msg: 'client error',
    });
    expect(line?.err).toMatchObject({
      type: 'TypeError',
      message: 'Cannot read properties of undefined (reading map)',
    });
  });

  it('keeps the browser’s stack, which is the whole point of the round trip', async () => {
    capture();
    await request(app).post('/api/client-errors').send(REPORT).expect(204);
    expect(exceptionLine()?.err).toMatchObject({ stack: expect.stringContaining('ItemsPage') });
  });

  it('joins the report to the server request that failed under it', async () => {
    capture();
    await request(app)
      .post('/api/client-errors')
      .send({ ...REPORT, requestId: 'the-call-that-500ed' })
      .expect(204);

    // The id of the failed API call, not the id of the POST carrying the
    // report - which is recorded separately, so both are recoverable.
    expect(exceptionLine()?.requestId).toBe('the-call-that-500ed');
    expect(exceptionLine()?.reportedVia).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records which build the browser was running', async () => {
    capture();
    await request(app)
      .post('/api/client-errors')
      .send({ ...REPORT, release: '0.1.0' })
      .expect(204);
    // A tab left open across a deploy is running code the server no longer has.
    expect(exceptionLine()?.release).toBe('0.1.0');
  });
});

describe('the payload comes from outside, so it is bounded and scrubbed', () => {
  it('scrubs a secret that ended up in the message', async () => {
    capture();
    await request(app)
      .post('/api/client-errors')
      .send({ ...REPORT, message: 'failed with Bearer eyJhbGciOiJIUzI1NiJ9.leaked' })
      .expect(204);

    expect(lines.join('\n')).not.toContain('eyJhbGciOiJIUzI1NiJ9.leaked');
    expect(lines.join('\n')).toContain('[redacted]');
  });

  it('scrubs a token out of the page URL it was reported from', async () => {
    capture();
    await request(app)
      .post('/api/client-errors')
      .send({ ...REPORT, url: 'https://invintelx.org/register?setup_token=super-secret' })
      .expect(204);

    expect(lines.join('\n')).not.toContain('super-secret');
  });

  it('rejects a report with no message rather than logging an empty line', async () => {
    const response = await request(app)
      .post('/api/client-errors')
      .send({ kind: 'error', message: '' })
      .expect(400);
    expect(response.body.error.code).toBe('bad_request');
  });

  it('rejects a kind it does not recognise', async () => {
    await request(app)
      .post('/api/client-errors')
      .send({ ...REPORT, kind: 'something-else' })
      .expect(400);
  });

  it('refuses a stack long enough to be a flooding tool', async () => {
    // An unauthenticated endpoint that writes to the log is a log-flooding tool
    // if the payload is not capped, and the stack is the field that grows.
    await request(app)
      .post('/api/client-errors')
      .send({ ...REPORT, stack: 'x'.repeat(20_000) })
      .expect(400);
  });

  it('is not a way to reach anything else', async () => {
    await request(app).get('/api/client-errors').expect(404);
  });
});
