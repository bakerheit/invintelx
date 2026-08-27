import { logger } from './logger.js';
import { redact } from './redact.js';
import { currentRequestId } from './requestContext.js';

/**
 * The one place an unhandled error is reported from, on either side of the app.
 *
 * "Sentry or equivalent" is a decision about where events are *sent*, and it is
 * not the same decision as where they are *collected*. This module is the
 * collection point: every 500, every uncaught exception, every rejection nobody
 * handled, and every browser error posted to `/api/client-errors` arrives here,
 * gets scrubbed, and is written to the structured log as an `exception` event.
 *
 * That is already a working error tracker for a self-hosted instance whose logs
 * go somewhere searchable. For invintelx.org it is also the seam: call
 * `setErrorReporter` at boot with something that ships the event onward, and
 * every capture in the codebase starts flowing to it without a single call site
 * changing. `docs/observability.md` has the Sentry adapter, which is about
 * fifteen lines and is not written here because `@sentry/node` is not a
 * dependency of this repo yet.
 */

/** Roughly Sentry's minimal event, so an adapter is a rename and not a translation. */
export interface ErrorEvent {
  /** Epoch milliseconds, so a reporter does not have to guess the clock. */
  timestamp: number;
  level: 'error' | 'fatal';
  /** Which process the error happened in. `web` events arrive via the client-error route. */
  side: 'api' | 'web';
  /** Constructor name where there was one, `Error` where there was not. */
  type: string;
  message: string;
  stack?: string;
  /** The request it belonged to, when it belonged to one. */
  requestId?: string;
  /** Already redacted, like everything else that leaves this module. */
  context: Record<string, unknown>;
}

export type ErrorReporter = (event: ErrorEvent) => void;

let reporter: ErrorReporter | undefined;

/** Pass nothing to detach — which is what the tests do in `afterEach`. */
export function setErrorReporter(next?: ErrorReporter): void {
  reporter = next;
}

export interface CaptureOptions {
  level?: 'error' | 'fatal';
  side?: 'api' | 'web';
  /** Free-form fields that land on both the log line and the reported event. */
  context?: Record<string, unknown>;
  /** Overrides the ambient request. The client-error route uses it to attribute a browser event. */
  requestId?: string;
  /** What the log line says. Defaults to a generic sentence, not the error text. */
  message?: string;
}

interface Described {
  type: string;
  message: string;
  stack?: string;
}

function describe(error: unknown): Described {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message,
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    };
  }
  /*
   * `throw 'oops'` and `Promise.reject(undefined)` both reach here. A thrown
   * non-Error has no stack, which is worth saying out loud in the log rather
   * than leaving the field mysteriously absent.
   */
  return { type: typeof error, message: safeString(error) };
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserialisable thrown value]';
  }
}

/**
 * Record an error that nothing else is going to handle.
 *
 * Never throws. It is called from the error middleware and from the process
 * handlers, and in both places the only thing worse than losing the report is
 * replacing the original failure with a failure to report it.
 */
export function captureException(error: unknown, options: CaptureOptions = {}): ErrorEvent {
  const described = describe(error);
  const level = options.level ?? 'error';
  const requestId = options.requestId ?? currentRequestId();

  const event: ErrorEvent = {
    timestamp: Date.now(),
    level,
    side: options.side ?? 'api',
    ...described,
    ...(requestId === undefined ? {} : { requestId }),
    context: redact(options.context ?? {}) as Record<string, unknown>,
  };

  logger[level](
    {
      event: 'exception',
      side: event.side,
      err: error,
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      ...options.context,
    },
    options.message ?? 'unhandled error',
  );

  if (reporter) {
    try {
      reporter(event);
    } catch (reportingFailure) {
      /*
       * A broken reporter must not become the incident. Logged once at warn -
       * through the same logger, which is still working, since it is what just
       * wrote the original event.
       */
      logger.warn({ err: reportingFailure, event: 'reporter_failed' }, 'error reporter threw');
    }
  }

  return event;
}

/**
 * Catch what escapes every handler in the process.
 *
 * Installed from `index.ts` and deliberately not from `createApp`, because the
 * test suite builds apps and these are process-global: a test that installs
 * them would change how every later test file dies.
 *
 * Returns an uninstall function, which is what the test for this uses.
 */
export function installProcessErrorHandlers(
  options: { exit?: (code: number) => void } = {},
): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const onUncaught = (error: unknown): void => {
    captureException(error, {
      level: 'fatal',
      context: { event: 'uncaught_exception' },
      message: 'uncaught exception, shutting down',
    });
    /*
     * Node's own behaviour, kept: an uncaught exception unwound a stack nobody
     * planned for, so this process's state is now a guess. Restarting is the
     * only honest response, and the process manager will. The log line above is
     * the only thing this handler adds - without it the platform's crash log is
     * all anybody gets.
     */
    exit(1);
  };

  const onUnhandledRejection = (reason: unknown): void => {
    /*
     * Not fatal, unlike the above, and that is a deliberate difference. Express
     * 5 forwards a rejected route handler to the error middleware on its own,
     * so a rejection that reaches here came from background work - a fire-and-
     * forget write, a timer - and killing every in-flight request over it is a
     * worse outage than the bug. Node's default would exit; this reports it
     * loudly instead, and `docs/observability.md` says so where an operator
     * will read it.
     */
    captureException(reason, {
      context: { event: 'unhandled_rejection' },
      message: 'unhandled promise rejection',
    });
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandledRejection);

  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandledRejection);
  };
}
