import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { env, isProduction } from './env.js';
import { healthcheck } from './db.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { loadUser, requireAuth } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { itemsRouter } from './routes/items.js';
import { locationsRouter } from './routes/locations.js';
import { movementsRouter } from './routes/movements.js';
import { suppliersRouter } from './routes/suppliers.js';
import { purchaseOrdersRouter } from './routes/purchaseOrders.js';
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
    console.log(`[invintelx-api] serving the web app from ${web.root}`);
  } else if (isProduction) {
    console.warn(
      `[invintelx-api] no web build at ${web.root}: serving /api only. Run ` +
        `\`pnpm build\`, set WEB_DIST, or put a reverse proxy in front that ` +
        `serves the assets itself.`,
    );
  }

  app.get('/api/health', (_req, res) => {
    void healthcheck().then((database) => {
      res.status(database ? 200 : 503).json({
        status: database ? 'ok' : 'degraded',
        // Unauthenticated on purpose: "which version is this" is the first
        // question of every deployment bug report, and an operator who cannot
        // sign in still has to be able to answer it.
        version: VERSION,
        database,
        uptimeSeconds: Math.round(process.uptime()),
      });
    });
  });

  app.use(loadUser);
  app.use('/api/auth', authRouter);
  app.use('/api/items', requireAuth, itemsRouter);
  app.use('/api/locations', requireAuth, locationsRouter);
  app.use('/api/movements', requireAuth, movementsRouter);
  app.use('/api/suppliers', requireAuth, suppliersRouter);
  app.use('/api/purchase-orders', requireAuth, purchaseOrdersRouter);
  app.use('/api/analytics', requireAuth, analyticsRouter);

  // Last chance before the 404: a client-side route that survives a refresh.
  app.use(web.spaFallback);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
