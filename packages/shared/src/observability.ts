import { z } from 'zod';

/**
 * What the browser sends when something breaks in it.
 *
 * Shared rather than declared twice because the whole value of this endpoint is
 * that the field the browser fills in is the field the server logs. Every limit
 * below is a server-side bound the client happens to also know: an unauthenticated
 * endpoint that writes to the log is a log-flooding tool if the payload is not
 * capped, and a stack trace is the field that grows without one.
 */

export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection', 'render'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export const clientErrorReportSchema = z.object({
  /** How it reached the reporter, which is most of what says where to look. */
  kind: z.enum(CLIENT_ERROR_KINDS),
  message: z.string().min(1).max(1000),
  /** The constructor name. Absent when what was thrown was not an Error. */
  name: z.string().max(200).optional(),
  stack: z.string().max(8000).optional(),
  /** The page it happened on. Query secrets are scrubbed server-side before logging. */
  url: z.string().max(2000).optional(),
  /**
   * The `X-Request-Id` of the API call that failed, where one did. This is what
   * joins a browser error to the server line for the request that caused it.
   */
  requestId: z.string().max(128).optional(),
  /** The release the browser is running, which may not be the one now deployed. */
  release: z.string().max(64).optional(),
});

export type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;
