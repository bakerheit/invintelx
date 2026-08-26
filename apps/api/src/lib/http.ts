import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { BadRequestError } from '../errors.js';

/**
 * Express 5 forwards rejected promises to the error middleware on its own, but
 * wrapping keeps the intent explicit and the types honest.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

/** Turns a Zod failure into field-keyed messages the form can render inline. */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    // First message per field wins; a stack of messages on one input is noise.
    fields[key] ??= issue.message;
  }
  throw new BadRequestError('Some fields need attention', fields);
}
