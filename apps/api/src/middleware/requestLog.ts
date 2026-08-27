import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../lib/logger.js';
import { redactUrl } from '../lib/redact.js';
import { runWithRequestContext } from '../lib/requestContext.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlates every log line, the response header and any client report. */
      id?: string;
    }
  }
}

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * What an inbound request id is allowed to look like.
 *
 * The header is attacker-controlled: it is echoed into a response header and
 * written into every log line for the request. Unchecked, a newline in it forges
 * log records, and a stray `\r` splits the response header. Accepting only this
 * alphabet makes both impossible, and it still covers every id a proxy in front
 * of us actually generates - a UUID, a hex trace id, a W3C traceparent.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Honoured rather than replaced, when it is safe. A load balancer that already
 * stamped an id is the only thing that can tie our line to its own, and
 * generating a second id here would break the one join anybody wanted.
 */
export function requestIdFrom(header: unknown): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return undefined;
  return SAFE_REQUEST_ID.test(raw) ? raw : undefined;
}

/**
 * Paths that would otherwise dominate the log.
 *
 * A platform health probe runs every few seconds forever, and a page load pulls
 * a dozen hashed assets. Both still produce a line at `debug`, so turning
 * `LOG_LEVEL` down gets them back when the question is "is the probe even
 * reaching us".
 */
function isRoutine(path: string): boolean {
  return path === '/health' || path === '/api/health' || path.startsWith('/assets/');
}

/**
 * Exported for its own test: the quieting only applies to responses that
 * succeeded, and proving that from an integration test would need a request
 * that is both routine and successful, which is a working database away.
 */
export function levelFor(status: number, path: string): 'debug' | 'info' | 'warn' | 'error' {
  // Status first, deliberately. A health probe answering 503 is the single most
  // important line in the log, and quieting it by path would hide the outage.
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return isRoutine(path) ? 'debug' : 'info';
}

/**
 * Gives every request an id, publishes it, and writes one line when it finishes.
 *
 * Mounted first, ahead of the body parsers, so a request that dies inside one
 * of them still has an id and still gets a line. The id goes into async context
 * rather than only onto `req`, so anything logging further down the stack is
 * stamped with it without having been handed the request - see
 * `lib/requestContext.ts`.
 */
export function requestLogger(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = requestIdFrom(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);

    const startedAt = process.hrtime.bigint();
    let logged = false;

    const finish = (aborted: boolean): void => {
      // 'finish' and 'close' both fire on a normal response, in that order.
      if (logged) return;
      logged = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const path = req.path;
      const status = res.statusCode;

      logger[levelFor(status, path)](
        {
          event: 'request',
          /*
           * Explicit, not inherited: these listeners were registered before the
           * async context below was entered, so the logger's ambient lookup
           * finds nothing here. The one line that most needs the id would be
           * the one line without it.
           */
          requestId,
          method: req.method,
          // originalUrl, not url: a router that has consumed its mount point
          // rewrites `url`, so `url` here would say `/42` and mean nothing.
          url: redactUrl(req.originalUrl),
          status,
          durationMs: Math.round(durationMs * 100) / 100,
          /*
           * Populated by `loadUser` long after this middleware ran, and read
           * here at finish time, which is why the line can say who it was.
           */
          ...(req.user ? { userId: req.user.id } : {}),
          ip: req.ip,
          ...(aborted ? { aborted: true } : {}),
        },
        aborted ? 'request aborted' : 'request completed',
      );
    };

    res.on('finish', () => {
      finish(false);
    });
    /*
     * A client that hangs up mid-response never fires 'finish'. Without this
     * the request simply has no line at all, which reads in the log as though
     * it never arrived - the opposite of what happened.
     */
    res.on('close', () => {
      finish(!res.writableEnded);
    });

    runWithRequestContext({ requestId }, next);
  };
}
