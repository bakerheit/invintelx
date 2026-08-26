import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type RequestHandler } from 'express';
import { env, isTest } from './env.js';

/*
 * In production the API serves the built web app itself, so the browser talks
 * to one origin. That is what keeps the session cookie same-origin, which is
 * the assumption `setSessionCookie` already makes with SameSite=Lax - a split
 * origin would need SameSite=None, Secure, and the CORS dance in app.ts.
 *
 * A reverse proxy in front is supported and documented, not required. Point it
 * at this process and it works either way.
 */

/**
 * `apps/web/dist` relative to this file. The same relative path lands in the
 * right place whether this module runs from `src` under tsx or from `dist`
 * after `pnpm build`, because both sit one level under `apps/api`.
 */
export const DEFAULT_WEB_DIST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../web/dist',
);

export interface WebAssets {
  /** Absolute directory that was checked, so a log line can name it. */
  root: string;
  /** A build is actually present there. When false the API serves only /api. */
  available: boolean;
  /**
   * Serves files that exist. Mounted before the session lookup, because an
   * asset request has no business costing a database round-trip in `loadUser`.
   */
  serveFiles: RequestHandler;
  /**
   * Answers anything the routers did not with `index.html`, so a client-side
   * route survives a page refresh. Mounted last, before the 404 handler.
   */
  spaFallback: RequestHandler;
}

/**
 * Resolves the web build and returns the two handlers that serve it.
 *
 * `configured` defaults to `WEB_DIST` from the environment. Passing it
 * explicitly is how the tests point at a fixture; an explicitly named
 * directory that is not a web build is a misconfiguration and throws, rather
 * than quietly starting an instance that 404s every page.
 */
export function webAssets(configured: string | undefined = env.WEB_DIST): WebAssets {
  const explicit = configured !== undefined;
  const root = explicit ? resolve(configured) : DEFAULT_WEB_DIST;
  const built = existsSync(join(root, 'index.html'));

  if (explicit && !built) {
    throw new Error(
      `WEB_DIST points at ${root}, which has no index.html. Build the web app ` +
        `with \`pnpm build\`, or leave WEB_DIST unset to serve only /api.`,
    );
  }

  /*
   * A dist left over in a developer's checkout must not change what the test
   * suite exercises - otherwise the API tests would pass or fail depending on
   * whether somebody had run a build. Tests opt in by naming a directory.
   */
  const available = built && (explicit || !isTest);

  if (!available) {
    const passthrough: RequestHandler = (_req, _res, next) => next();
    return { root, available, serveFiles: passthrough, spaFallback: passthrough };
  }

  const files = express.static(root, {
    // `/` is handled by the fallback instead, so index.html leaves this process
    // by exactly one path and therefore with exactly one set of headers.
    index: false,
    dotfiles: 'ignore',
    redirect: false,
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', cacheControlFor(filePath));
    },
  });

  const serveFiles: RequestHandler = (req, res, next) => {
    // /api belongs to the routers. No file on disk may shadow it.
    if (isApiPath(req.path)) return next();
    files(req, res, next);
  };

  const indexHtml = join(root, 'index.html');

  const spaFallback: RequestHandler = (req, res, next) => {
    if (isApiPath(req.path)) return next();
    // A POST to an unknown path is a mistake, not a page. Let it 404 as JSON.
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    /*
     * A miss under assets/ means a stale cache or a half-finished deploy.
     * Answering it with HTML turns that into an unreadable MIME error in the
     * browser console; a 404 says what actually happened.
     */
    if (req.path.startsWith('/assets/')) return next();

    res.sendFile(indexHtml, { headers: { 'Cache-Control': 'no-cache' } }, (err?: Error) => {
      if (err) next(err);
    });
  };

  return { root, available, serveFiles, spaFallback };
}

function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Vite writes content-hashed filenames into `assets/`: the name changes when
 * the bytes do, so those can be cached forever. Everything else - index.html,
 * and anything copied verbatim out of `public/` - keeps its name across
 * releases, so it has to be revalidated or an upgrade never reaches a browser
 * that has been there before.
 */
function cacheControlFor(filePath: string): string {
  return filePath.includes(`${sep}assets${sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}
