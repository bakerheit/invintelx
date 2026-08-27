import type { ClientErrorKind, ClientErrorReport } from '@invintelx/shared';

/**
 * Browser errors, sent to the API so they land in the same log as everything
 * else.
 *
 * A crash in the browser is invisible to the server: the request that caused it
 * returned 200, and the only trace is a console message on a machine nobody
 * operating this app can see. This is the wire that fixes that. The server end
 * (`routes/clientErrors.ts`) turns each report into the same `exception` event
 * an API failure produces, which means one search finds both halves of a bug
 * that crossed the wire.
 *
 * Everything here is best-effort and silent. The page is already broken; a
 * reporter that throws, blocks, or renders anything makes it worse.
 */

const ENDPOINT = '/api/client-errors';

/**
 * The build this tab is running, substituted by Vite from `apps/web/package.json`.
 *
 * Worth a field of its own because it is the one thing the server cannot infer:
 * a tab left open across a deploy reports against the release it loaded, not the
 * release now answering its requests, and "only happens on the old build" is
 * otherwise an hour of confusion. Undefined under Vitest, which does not run
 * the app's Vite config.
 */
const RELEASE: string | undefined = import.meta.env.VITE_APP_VERSION;

/**
 * A broken render throws on every attempt, and a bad interval throws forever.
 * Without a cap, one bug becomes an unbounded stream of identical POSTs from
 * every open tab — a self-inflicted flood that hides the error it is reporting.
 */
const MAX_REPORTS_PER_PAGE_LOAD = 10;

/** Reset only by a reload, which is the point: the same bug reports once per visit. */
const seen = new Set<string>();
let sent = 0;

/** The `X-Request-Id` of the most recent failed API call, if there was one. */
let lastFailedRequestId: string | undefined;

/**
 * Called by the API client when a request fails, so the next error reported can
 * name the server-side request that preceded it. Approximate by construction —
 * it is the last failure, not necessarily the cause — which is why the server
 * logs it as context rather than as the report's own identity.
 */
export function noteFailedRequest(requestId: string | undefined): void {
  if (requestId) lastFailedRequestId = requestId;
}

/** Only for tests: a page load is otherwise the only thing that clears this. */
export function resetErrorReporting(): void {
  seen.clear();
  sent = 0;
  lastFailedRequestId = undefined;
}

function describe(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name,
      name: error.name,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

/**
 * Send one error to the API. Returns whether it was sent, which is what the
 * tests assert on — nothing in the app should branch on it.
 */
export function reportClientError(
  error: unknown,
  options: { kind?: ClientErrorKind; requestId?: string } = {},
): boolean {
  const described = describe(error);
  if (!described.message) return false;

  const kind = options.kind ?? 'error';
  const fingerprint = `${kind}:${described.name ?? ''}:${described.message}`;
  if (seen.has(fingerprint)) return false;
  if (sent >= MAX_REPORTS_PER_PAGE_LOAD) return false;
  seen.add(fingerprint);
  sent += 1;

  const requestId = options.requestId ?? lastFailedRequestId;

  const report: ClientErrorReport = {
    kind,
    // Trimmed here as well as validated server-side. A 40KB stack rejected by
    // the schema is a report that never arrives, which is the failure mode this
    // whole module exists to avoid.
    message: described.message.slice(0, 1000),
    ...(described.name ? { name: described.name.slice(0, 200) } : {}),
    ...(described.stack ? { stack: described.stack.slice(0, 8000) } : {}),
    url: window.location.href.slice(0, 2000),
    ...(requestId ? { requestId } : {}),
    ...(RELEASE ? { release: RELEASE } : {}),
  };

  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      // The error that matters most is the one during a navigation away. Without
      // this the browser cancels the request as the page unloads.
      keepalive: true,
    }).catch(() => {
      /* The reporter failing is not itself worth reporting. */
    });
  } catch {
    return false;
  }

  return true;
}

/**
 * Catch what React cannot.
 *
 * The route error boundaries handle anything thrown during render or in a
 * loader. Everything else — a throw inside a `setTimeout`, a rejected promise
 * nobody awaited, a failing event handler — bypasses React entirely and would
 * otherwise exist only in the user's console.
 *
 * Returns an uninstall function, which is what the tests use.
 */
export function installGlobalErrorReporting(): () => void {
  const onError = (event: ErrorEvent): void => {
    reportClientError(event.error ?? event.message, { kind: 'error' });
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    reportClientError(event.reason, { kind: 'unhandledrejection' });
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
