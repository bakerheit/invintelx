import { beforeAll, describe, expect, it } from 'vitest';
import { runWithRequestContext } from './requestContext.js';
import { REDACTED } from './redact.js';

/**
 * `env.ts` parses at import time and kills the process on a bad environment, so
 * these have to be set before anything under test is imported - the same dance
 * `web.test.ts` does, for the same reason.
 */
let logger: typeof import('./logger.js');

const lines: string[] = [];
const captured = (line: string): void => {
  lines.push(line);
};

function records(): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  logger = await import('./logger.js');
});

describe('the record format', () => {
  it('is pino’s, so pino-pretty and every hosted preset already read it', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured, now: () => 1_700_000 });
    log.info({ itemId: 'abc' }, 'item created');

    expect(records()[0]).toMatchObject({
      level: 30,
      time: 1_700_000,
      pid: process.pid,
      msg: 'item created',
      itemId: 'abc',
    });
    expect(records()[0]).toHaveProperty('hostname');
  });

  it('accepts a bare message, like pino does', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });
    log.warn('something odd');
    expect(records()[0]).toMatchObject({ level: 40, msg: 'something odd' });
  });

  it('numbers the levels the way every consumer of these expects', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'trace', destination: captured });
    log.trace('a');
    log.debug('b');
    log.info('c');
    log.warn('d');
    log.error('e');
    log.fatal('f');
    expect(records().map((r) => r.level)).toEqual([10, 20, 30, 40, 50, 60]);
  });
});

describe('what gets emitted at all', () => {
  it('drops anything below the configured level', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'warn', destination: captured });
    log.info('ignored');
    log.debug('ignored');
    log.warn('kept');
    expect(records()).toHaveLength(1);
    expect(records()[0]?.msg).toBe('kept');
  });

  it('emits nothing at all when silent, which is what the test suite runs at', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'silent', destination: captured });
    log.fatal('not even this');
    expect(lines).toHaveLength(0);
  });
});

describe('children', () => {
  it('stamp their bindings on every record', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });
    log.child({ component: 'ledger' }).info('wrote');
    expect(records()[0]).toMatchObject({ component: 'ledger', msg: 'wrote' });
  });

  it('inherit rather than replace, so a grandchild carries both', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });
    log.child({ a: 1 }).child({ b: 2 }).info('both');
    expect(records()[0]).toMatchObject({ a: 1, b: 2 });
  });
});

describe('the request id, threaded rather than passed', () => {
  it('lands on a line written by code that was never given the request', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });

    // Stands in for a service four calls below a route handler.
    function somewhereDeep(): void {
      log.info('did some work');
    }

    runWithRequestContext({ requestId: 'req-42' }, somewhereDeep);
    expect(records()[0]?.requestId).toBe('req-42');
  });

  it('survives an await, which is where a naive implementation loses it', async () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });

    await runWithRequestContext({ requestId: 'req-async' }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      log.info('after two hops');
    });

    expect(records()[0]?.requestId).toBe('req-async');
  });

  it('is absent outside a request, rather than being invented', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });
    log.info('boot');
    expect(records()[0]).not.toHaveProperty('requestId');
  });

  it('yields to an explicit one, which is how a browser error keeps its own id', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });
    runWithRequestContext({ requestId: 'the-post' }, () => {
      log.info({ requestId: 'the-request-that-broke' }, 'client error');
    });
    expect(records()[0]?.requestId).toBe('the-request-that-broke');
  });
});

describe('redaction, on the way out and not at the call site', () => {
  it('scrubs a secret nobody at the call site remembered to remove', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });
    log.info({ body: { email: 'a@b.c', password: 'hunter2' } }, 'login attempt');

    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).toContain(REDACTED);
    expect(lines[0]).toContain('a@b.c');
  });

  it('scrubs bindings too, not only the fields of one call', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });
    log.child({ cookie: 'invintelx_session=abc' }).info('hello');
    expect(lines[0]).not.toContain('abc');
  });

  it('writes a line even when handed something that cannot be serialised', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', destination: captured });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    log.error({ cyclic }, 'still logged');
    expect(records()[0]?.msg).toBe('still logged');
  });

  it('swallows a destination that throws, rather than becoming the incident', () => {
    const log = logger.createLogger({
      level: 'info',
      destination: () => {
        throw new Error('the log pipe is gone');
      },
    });
    expect(() => {
      log.error('something already went wrong');
    }).not.toThrow();
  });
});

describe('the human-readable format', () => {
  it('leads with a timestamp, a level and the message', () => {
    lines.length = 0;
    const log = logger.createLogger({
      level: 'info',
      format: 'pretty',
      destination: captured,
      now: () => Date.parse('2026-08-27T03:54:23.326Z'),
    });
    log.info({ status: 200 }, 'request completed');

    expect(lines[0]).toContain('2026-08-27T03:54:23.326Z');
    expect(lines[0]).toContain('INFO');
    expect(lines[0]).toContain('request completed');
    expect(lines[0]).toContain('status=200');
  });

  it('puts a stack on its own lines instead of inside a JSON string', () => {
    lines.length = 0;
    const log = logger.createLogger({ level: 'info', format: 'pretty', destination: captured });
    log.error({ err: new Error('boom') }, 'failed');
    expect(lines[0]).toContain('err=Error: boom');
    expect(lines[0]?.split('\n').length).toBeGreaterThan(1);
  });
});
