import { Router } from 'express';
import { clientErrorReportSchema } from '@invintelx/shared';
import { isTest } from '../env.js';
import { captureException } from '../lib/errorTracking.js';
import { parseOrThrow } from '../lib/http.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { redactUrl } from '../lib/redact.js';

export const clientErrorsRouter: Router = Router();

/**
 * Deliberately generous and deliberately finite. A single broken render can
 * throw on every frame, and the browser-side reporter already dedupes and caps
 * itself - this is the bound that holds when the thing posting is not our
 * reporter at all.
 */
const reportLimiter = createRateLimiter({
  limit: 30,
  windowMs: 5 * 60 * 1000,
  message: 'Too many error reports. Slow down.',
  enabled: !isTest,
});

/**
 * Where browser errors become server log lines.
 *
 * Unauthenticated on purpose: the errors most worth hearing about are the ones
 * that stopped somebody signing in, and requiring a session would filter out
 * exactly those. What that costs is an endpoint a stranger can write to, which
 * is why the payload is schema-bounded, the rate limiter is per-IP, and every
 * field goes through the same redactor as everything else before it is written.
 *
 * A stranger can therefore put a string in this instance's log. They could
 * already do that with a 404, and the line is clearly labelled `side: web`.
 */
clientErrorsRouter.post('/', (req, res) => {
  reportLimiter(req.ip ?? 'unknown');
  const report = parseOrThrow(clientErrorReportSchema, req.body);

  /*
   * Reconstructed as an Error so the browser's stack lands in the same `err`
   * field, with the same shape, as one thrown here. A reporter reading these
   * events should not have to know which side of the wire they came from.
   */
  const error = new Error(report.message);
  error.name = report.name ?? 'ClientError';
  if (report.stack !== undefined) error.stack = report.stack;

  captureException(error, {
    side: 'web',
    // The browser's id when it had one - the API request that failed under it.
    // Otherwise this POST's own id, which at least locates it in time.
    ...(report.requestId === undefined ? {} : { requestId: report.requestId }),
    context: {
      kind: report.kind,
      ...(report.url === undefined ? {} : { url: redactUrl(report.url) }),
      ...(report.release === undefined ? {} : { release: report.release }),
      userAgent: req.get('user-agent') ?? 'unknown',
      // Which request carried the report, as distinct from which request broke.
      reportedVia: req.id,
    },
    message: 'client error',
  });

  // Nothing to say back. The browser is already broken; do not make it parse a body.
  res.status(204).end();
});
