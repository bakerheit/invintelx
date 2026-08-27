import { apiErrorSchema } from '@invintelx/shared';
import type { z } from 'zod';
import { noteFailedRequest } from './errorReporting';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Field-keyed messages from server-side validation, for inline form errors. */
    readonly fields?: Record<string, string>,
    /**
     * The server's `X-Request-Id` for the call that failed. Carried so a bug
     * report, or an error reported from the browser, can name the exact request
     * whose lines are already in the server log.
     */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/**
 * Registered by the auth provider. Any 401 anywhere in the app means the
 * session is gone, and every screen should react at once rather than each
 * query rendering its own broken state.
 */
let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(fn: (() => void) | undefined): void {
  onUnauthorized = fn;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const { method = 'GET', body, signal } = options;

  const response = await fetch(`/api${path}`, {
    method,
    // Session lives in an httpOnly cookie, so it has to ride along explicitly.
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  // Set on every response by the API's request logger, so it is here whether the
  // call succeeded or not - but only worth keeping when it did not.
  const requestId = response.headers.get('x-request-id') ?? undefined;

  if (response.status === 204) return undefined;

  const text = await response.text();
  const payload: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

  if (!response.ok) {
    noteFailedRequest(requestId);
    const parsed = apiErrorSchema.safeParse(payload);
    const error = parsed.success
      ? new ApiError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.fields,
          requestId,
        )
      : new ApiError(
          response.status,
          'unknown_error',
          `Request failed (${response.status})`,
          undefined,
          requestId,
        );

    // The /me probe on boot is expected to 401 when signed out; the caller
    // handles that one, so only fire the global hook for real sessions dying.
    if (error.isUnauthorized && path !== '/auth/me') onUnauthorized?.();
    throw error;
  }

  return payload;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parses the response through the shared schema. If the server's shape drifts
 * from the contract, it fails here with a clear message instead of surfacing as
 * `undefined is not an object` three components deep.
 */
export async function apiRequest<T extends z.ZodTypeAny>(
  schema: T,
  path: string,
  options?: RequestOptions,
): Promise<z.infer<T>> {
  const payload = await request(path, options);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error('Response did not match the API contract', { path, issues: parsed.error.issues });
    throw new ApiError(500, 'contract_mismatch', 'The server returned an unexpected response');
  }
  return parsed.data;
}

/** For endpoints that return nothing worth parsing, like logout. */
export async function apiVoid(path: string, options?: RequestOptions): Promise<void> {
  await request(path, options);
}

export function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}
