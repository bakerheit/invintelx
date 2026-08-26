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
import { analyticsRouter } from './routes/analytics.js';

export function createApp(): Express {
  const app = express();

  // Behind a proxy in production, so req.ip reflects the client rather than the
  // load balancer - the rate limiter keys on it.
  if (isProduction) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  /**
   * In development Vite proxies /api, so requests are same-origin and this never
   * fires. It exists for a production topology where the web app is served from
   * a different origin than the API.
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

  app.get('/api/health', (_req, res) => {
    void healthcheck().then((database) => {
      res.status(database ? 200 : 503).json({
        status: database ? 'ok' : 'degraded',
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
  app.use('/api/analytics', requireAuth, analyticsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
