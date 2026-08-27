import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * The request-id thread, end to end through the real middleware stack.
 *
 * No mongod: nothing here needs one. An unauthenticated request carries no
 * session cookie, so `loadUser` returns before it queries anything, and the
 * health route is *supposed* to answer 503 when the database is unreachable -
 * which, with no mongod running, is exactly the state under test.
 */
let app: Express;
let logging: typeof import('../lib/logger.js');

const lines: string[] = [];

function records(): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The one line the request logger writes when a response finishes. */
function requestLine(): Record<string, unknown> | undefined {
  return records().find((record) => record.event === 'request');
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  // The suite is silent by default. `debug` because the health probe and the
  // asset paths are deliberately logged below `info`.
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

describe('every response carries an id', () => {
  it('mints one and publishes it in a header', async () => {
    const response = await request(app).get('/api/health');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives two requests two different ids', async () => {
    const first = await request(app).get('/api/health');
    const second = await request(app).get('/api/health');
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('honours the id a proxy in front of us already stamped', async () => {
    // Minting a second one here would break the only join anybody wanted: the
    // load balancer's line and ours, for the same request.
    const response = await request(app)
      .get('/api/health')
      .set('X-Request-Id', '0af7651916cd43dd8448eb211c80319c');
    expect(response.headers['x-request-id']).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('refuses an inbound id that could forge a log record', async () => {
    /*
     * The header is attacker-controlled and is written verbatim into every line
     * for this request and into a response header. A raw newline cannot even be
     * transmitted - Node's client refuses to send one - but its encoded form
     * can, and anything in front of us that decodes before we do would hand us
     * one. The allowlist is what makes that a non-question.
     */
    const response = await request(app)
      .get('/api/health')
      .set('X-Request-Id', '%0d%0a{"level":60,"msg":"forged"}');

    expect(response.headers['x-request-id']).not.toContain('forged');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses one long enough to be a payload', async () => {
    const response = await request(app).get('/api/health').set('X-Request-Id', 'a'.repeat(400));
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('the line written when a request finishes', () => {
  it('says what happened, and carries the same id as the header', async () => {
    capture();
    const response = await request(app).get('/api/items?page=2');

    const line = requestLine();
    expect(line).toMatchObject({
      method: 'GET',
      url: '/api/items?page=2',
      status: 401,
      requestId: response.headers['x-request-id'],
      msg: 'request completed',
    });
    expect(typeof line?.durationMs).toBe('number');
  });

  it('logs a rejected request at warn rather than as a failure', async () => {
    capture();
    await request(app).get('/api/items');
    expect(requestLine()?.level).toBe(40);
  });

  it('keeps a secret out of the URL it logs', async () => {
    capture();
    await request(app).get('/api/auth/setup?setup_token=super-secret-value');
    expect(lines.join('\n')).not.toContain('super-secret-value');
    expect(requestLine()?.url).toContain('[redacted]');
  });

  it('never logs the session cookie that came in with the request', async () => {
    capture();
    await request(app).get('/api/items').set('Cookie', 'invintelx_session=a-live-session-token');
    expect(lines.join('\n')).not.toContain('a-live-session-token');
  });

  it('shouts when the health probe itself fails', async () => {
    capture();
    // No mongod here, so the probe reports 503 - which is the single line in
    // this log an operator most needs to see, and is not quieted by path.
    await request(app).get('/health');
    expect(requestLine()?.status).toBe(503);
    expect(requestLine()?.level).toBe(50);
  });
});

describe('which lines are worth an operator’s attention', () => {
  it('drops a successful health probe below info, so it cannot drown the log', async () => {
    const { levelFor } = await import('./requestLog.js');
    // A platform probe runs every few seconds forever. Still emitted, because
    // "is the probe even reaching us" is a real question - just not at the
    // level an operator reads by default.
    expect(levelFor(200, '/health')).toBe('debug');
    expect(levelFor(200, '/api/health')).toBe('debug');
    expect(levelFor(200, '/assets/index-B7f3Kq2x.js')).toBe('debug');
  });

  it('keeps ordinary traffic at info', async () => {
    const { levelFor } = await import('./requestLog.js');
    expect(levelFor(200, '/api/items')).toBe('info');
    expect(levelFor(304, '/api/items')).toBe('info');
  });

  it('never quiets a failure, whatever the path', async () => {
    const { levelFor } = await import('./requestLog.js');
    expect(levelFor(404, '/assets/gone.js')).toBe('warn');
    expect(levelFor(503, '/health')).toBe('error');
  });
});

describe('the id reaches code that was never handed the request', () => {
  it('stamps the exception line for a failure deep inside the stack', async () => {
    capture();
    /*
     * No mongod, so `loadUser` cannot query - the failure surfaces through the
     * error middleware, which captures it. A real 500 from a real stack, which
     * is what makes this worth asserting on: nothing in `loadUser` was handed
     * the request id, and the line carries it anyway.
     */
    const response = await request(app)
      .get('/api/items')
      .set('Cookie', 'invintelx_session=whatever');

    expect(response.status).toBe(500);
    const exception = records().find((record) => record.event === 'exception');
    expect(exception?.requestId).toBe(response.headers['x-request-id']);
    expect(requestLine()?.requestId).toBe(response.headers['x-request-id']);
  });
});
