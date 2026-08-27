import type { NextFunction, Request, Response } from 'express';
import { MongoServerError } from 'mongodb';
import { AppError, ConflictError, NotFoundError } from '../errors.js';
import { isProduction } from '../env.js';
import { captureException } from '../lib/errorTracking.js';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError('No route matches that path'));
}

/**
 * The single place that knows the error envelope. Routes throw domain errors;
 * anything unrecognised becomes a 500 with a generic message, because internal
 * error text has a habit of containing things users should not see.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);

  const normalized = normalize(err);

  /*
   * Only 5xx. A 404 or a failed password is the system working, and reporting
   * those as errors is how an error tracker becomes something people mute.
   * Every status, 4xx included, still appears on the request line that
   * `requestLog` writes when the response finishes.
   */
  if (normalized.status >= 500) {
    captureException(err, {
      context: { method: req.method, route: req.path, status: normalized.status },
      message: 'request failed',
    });
  }

  res.status(normalized.status).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.fields ? { fields: normalized.fields } : {}),
    },
  });
}

function isPayloadTooLarge(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: unknown }).type === 'entity.too.large'
  );
}

function normalize(err: unknown): {
  status: number;
  code: string;
  message: string;
  fields?: Record<string, string>;
} {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) };
  }

  /*
   * body-parser's own error for a body over the limit. Left as a 500 it reads
   * as "the server broke", when in fact the server understood perfectly and the
   * file is simply too big - which is a thing the person uploading it can act on.
   */
  if (isPayloadTooLarge(err)) {
    return {
      status: 413,
      code: 'payload_too_large',
      message: 'That upload is too large for this endpoint',
    };
  }

  // A duplicate key means two requests raced past the application-level check.
  // The index is the real guarantee, so translate rather than 500.
  if (err instanceof MongoServerError && err.code === 11000) {
    const field = Object.keys((err.keyPattern as Record<string, unknown>) ?? {})[0] ?? 'value';
    const conflict = new ConflictError(`That ${field} is already in use`, { [field]: 'Already in use' });
    return { status: conflict.status, code: conflict.code, message: conflict.message, fields: conflict.fields };
  }

  return {
    status: 500,
    code: 'internal_error',
    message: isProduction ? 'Something went wrong' : `${(err as Error)?.message ?? 'Unknown error'}`,
  };
}
