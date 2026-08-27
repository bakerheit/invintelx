import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { env, isProduction } from './env.js';
import { healthcheck } from './db.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestLogger } from './middleware/requestLog.js';
import { loadUser, requireAuth } from './middleware/auth.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { clientErrorsRouter } from './routes/clientErrors.js';
import { itemsRouter } from './routes/items.js';
import { locationsRouter } from './routes/locations.js';
import { movementsRouter } from './routes/movements.js';
import { suppliersRouter } from './routes/suppliers.js';
import { analyticsRouter } from './routes/analytics.js';
import { webAssets } from './web.js';
import { VERSION } from './version.js';

export function createApp(): Express {
  const app = express();
  const web = webAssets();

  // Behind a proxy in production, so req.ip reflects the client rather than the
  // load balancer - the rate limiter keys on it.
  if (isProduction) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  /*
   * First, ahead of the body parsers: a request that dies inside one of those -
   * a 16MB CSV, malformed JSON - is exactly the request somebody will want a
   * line for, and mounting this after them would be the one case with no id.
   */
  app.use(requestLogger());

  /*
   * A CSV import carries the whole file in its body, which is the one request
   * in this product that is legitimately large - four thousand SKUs is a few
   * hundred kilobytes before anyone has written a long description. Mounted
   * ahead of the general parser because body-parser skips a body that has
   * already been read, so the first parser to match a path is the one whose
   * limit applies. Everything else stays on the tight limit.
   */
  app.use('/api/items/import', express.json({ limit: '16mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  /**
   * Normally dead code. In development Vite proxies /api, and in production
   * this process serves the web app itself, so requests are same-origin either
   * way and this never fires. It exists only for a deployment that puts the web
   * app on a different origin - which also needs SameSite=None cookies to work,
   * so this alone is not enough to make that topology function.
   */
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === env.WEB_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  /*
   * Before `loadUser`, so serving a stylesheet does not cost a session lookup
   * in Mongo. The matching fallback goes in last, after the routers have had
   * their chance at the path.
   */
  app.use(web.serveFiles);

  if (web.available) {
    logger.info({ event: 'web_assets', root: web.root }, 'serving the web app');
  } else if (isProduction) {
    logger.warn(
      { event: 'web_assets', root: web.root },
      'no web build found: serving /api only. Run `pnpm build`, set WEB_DIST, or ' +
        'put a reverse proxy in front that serves the assets itself.',
    );
  }

  /**
   * What a platform's health check polls.
   *
   * Two paths for one handler. `/api/health` is what this app has always
   * reported at and what the docs and the release tooling name; `/health` is
   * where every host looks by default, and a probe misconfigured by one path
   * segment reads as "the instance is down" for as long as nobody notices.
   * Registering both costs a line and removes the failure mode.
   *
   * Ahead of `loadUser`, so a probe every three seconds forever does not become
   * a session lookup in Mongo every three seconds forever.
   */
  app.get(['/health', '/api/health'], (_req, res, next) => {
    healthcheck()
      .then((database) => {
        /*
         * 503 when the database is unreachable, which is what makes this worth
         * polling: a process that is listening but cannot read anything is not
         * healthy, and a probe that only checks the port would keep it in the
         * load balancer.
         */
        res.status(database ? 200 : 503).json({
          status: database ? 'ok' : 'degraded',
          // Unauthenticated on purpose: "which version is this" is the first
          // question of every deployment bug report, and an operator who cannot
          // sign in still has to be able to answer it.
          version: VERSION,
          database,
          uptimeSeconds: Math.round(process.uptime()),
        });
      })
      .catch(next);
  });

  app.use(loadUser);
  /*
   * Before the authenticated routers and outside them: a browser error on the
   * login page is the one this most needs to hear about, and by definition it
   * has no session. `loadUser` still ran, so a report from a signed-in browser
   * is still attributed.
   */
  app.use('/api/client-errors', clientErrorsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/items', requireAuth, itemsRouter);
  app.use('/api/locations', requireAuth, locationsRouter);
  app.use('/api/movements', requireAuth, movementsRouter);
  app.use('/api/suppliers', requireAuth, suppliersRouter);
  app.use('/api/analytics', requireAuth, analyticsRouter);
  app.use('/api/audit', requireAuth, auditRouter);

  // Last chance before the 404: a client-side route that survives a refresh.
  app.use(web.spaFallback);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
