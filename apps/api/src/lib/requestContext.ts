import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The request a piece of work belongs to, carried without being passed.
 *
 * The alternative is threading a logger down through every service call so that
 * `ledger.ts` can say which request it was writing for. That is a parameter on
 * a dozen signatures which exists only for logging, and the first function that
 * forgets it silently breaks the thread. `AsyncLocalStorage` keeps the id
 * attached to the async work itself, so `logger.info()` anywhere beneath a
 * request stamps the same id with nothing in between knowing about it.
 *
 * Empty outside a request - migrations, the seed script, the boot sequence -
 * and the logger simply omits the field there.
 */
export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
