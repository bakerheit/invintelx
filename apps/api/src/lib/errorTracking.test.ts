import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from './requestContext.js';
import { REDACTED } from './redact.js';
import type { ErrorEvent } from './errorTracking.js';

let tracking: typeof import('./errorTracking.js');
let logging: typeof import('./logger.js');

const lines: string[] = [];

function records(): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  /*
   * The suite defaults to `silent` so that hundreds of request lines do not
   * bury a failing assertion. This file is about what gets written, so it opts
   * back in - before importing the logger, which reads the level once at
   * import. `json` because these tests parse the lines.
   */
  process.env.LOG_LEVEL = 'error';
  process.env.LOG_FORMAT = 'json';
  logging = await import('./logger.js');
  tracking = await import('./errorTracking.js');
});

afterEach(() => {
  tracking.setErrorReporter();
  lines.length = 0;
  logging.setLogDestination();
});

afterAll(() => {
  logging.setLogDestination();
  delete process.env.LOG_LEVEL;
  delete process.env.LOG_FORMAT;
});

describe('capturing an error', () => {
  it('describes an Error without losing its stack', () => {
    const event = tracking.captureException(new TypeError('cannot read x of undefined'));
    expect(event.type).toBe('TypeError');
    expect(event.message).toBe('cannot read x of undefined');
    expect(event.stack).toContain('TypeError');
    expect(event.side).toBe('api');
    expect(event.level).toBe('error');
  });

  it('handles a thrown non-Error, which is what a rejected promise usually is', () => {
    const event = tracking.captureException('just a string');
    expect(event.type).toBe('string');
    expect(event.message).toBe('just a string');
    expect(event.stack).toBeUndefined();
  });

  it('attributes the event to the request it happened in, without being told', () => {
    const event = runWithRequestContext({ requestId: 'req-7' }, () =>
      tracking.captureException(new Error('boom')),
    );
    expect(event.requestId).toBe('req-7');
  });

  it('lets a browser event keep the id of the request that actually broke', () => {
    const event = runWithRequestContext({ requestId: 'the-post' }, () =>
      tracking.captureException(new Error('boom'), { side: 'web', requestId: 'the-failed-call' }),
    );
    expect(event.requestId).toBe('the-failed-call');
    expect(event.side).toBe('web');
  });

  it('scrubs the context it was handed', () => {
    const event = tracking.captureException(new Error('boom'), {
      context: { route: '/api/auth/login', password: 'hunter2' },
    });
    expect(event.context.route).toBe('/api/auth/login');
    expect(event.context.password).toBe(REDACTED);
  });
});

describe('what reaches the log', () => {
  it('writes one exception event carrying the request id and the error', () => {
    logging.setLogDestination((line) => lines.push(line));

    runWithRequestContext({ requestId: 'req-9' }, () => {
      tracking.captureException(new Error('the database went away'), {
        context: { route: '/api/items' },
        message: 'request failed',
      });
    });

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      level: 50,
      event: 'exception',
      side: 'api',
      requestId: 'req-9',
      route: '/api/items',
      msg: 'request failed',
    });
    expect(records()[0]?.err).toMatchObject({ message: 'the database went away' });
  });

  it('scrubs the context on the way to the log, not only on the event', () => {
    logging.setLogDestination((line) => lines.push(line));
    tracking.captureException(new Error('boom'), {
      context: { password: 'hunter2', cookie: 'invintelx_session=abc' },
    });

    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('invintelx_session=abc');
    expect(lines[0]).toContain(REDACTED);
  });

  it('says so at warn when the reporter itself throws', () => {
    logging.setLogDestination((line) => lines.push(line));
    tracking.setErrorReporter(() => {
      throw new Error('sentry is down');
    });
    tracking.captureException(new Error('the real problem'));

    // warn is below this file's `error` threshold, so only the exception line
    // lands. What matters is that neither throws.
    expect(records()[0]).toMatchObject({ event: 'exception' });
  });
});

describe('the reporter seam — where Sentry would attach', () => {
  it('hands every captured event to whatever was registered', () => {
    const received: ErrorEvent[] = [];
    tracking.setErrorReporter((event) => received.push(event));

    tracking.captureException(new Error('first'));
    tracking.captureException(new Error('second'));

    expect(received.map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('stops sending once it is detached', () => {
    const reporter = vi.fn();
    tracking.setErrorReporter(reporter);
    tracking.setErrorReporter();
    tracking.captureException(new Error('nobody is listening'));
    expect(reporter).not.toHaveBeenCalled();
  });

  it('does not let a broken reporter become the failure', () => {
    tracking.setErrorReporter(() => {
      throw new Error('sentry is down');
    });
    expect(() => tracking.captureException(new Error('the real problem'))).not.toThrow();
  });
});

describe('errors that escape every handler', () => {
  it('reports an uncaught exception as fatal and lets the process die', () => {
    const exit = vi.fn();
    const received: ErrorEvent[] = [];
    tracking.setErrorReporter((event) => received.push(event));

    const uninstall = tracking.installProcessErrorHandlers({ exit });
    /*
     * Invoked directly rather than by emitting on `process`: emitting would also
     * run Vitest's own uncaughtException handler and fail the run around the
     * assertion.
     */
    const handler = process.listeners('uncaughtException').at(-1);
    handler?.(new Error('escaped'), 'uncaughtException');

    expect(received[0]?.level).toBe('fatal');
    expect(received[0]?.message).toBe('escaped');
    expect(exit).toHaveBeenCalledWith(1);
    uninstall();
  });

  it('reports an unhandled rejection without killing the process', () => {
    const exit = vi.fn();
    const received: ErrorEvent[] = [];
    tracking.setErrorReporter((event) => received.push(event));

    const uninstall = tracking.installProcessErrorHandlers({ exit });
    const handler = process.listeners('unhandledRejection').at(-1);
    handler?.(new Error('nobody awaited this'), Promise.resolve());

    expect(received[0]?.level).toBe('error');
    expect(received[0]?.context.event).toBe('unhandled_rejection');
    // Express forwards a rejected route handler to the error middleware, so a
    // rejection reaching here is background work. Killing every in-flight
    // request over it would be the worse outage.
    expect(exit).not.toHaveBeenCalled();
    uninstall();
  });

  it('leaves no listeners behind when uninstalled', () => {
    const before = process.listenerCount('uncaughtException');
    const uninstall = tracking.installProcessErrorHandlers({ exit: vi.fn() });
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    uninstall();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});
