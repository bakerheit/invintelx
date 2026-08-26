import { env } from './env.js';
import { connect, disconnect, ensureIndexes } from './db.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  await connect();
  await ensureIndexes();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`[invintelx-api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[invintelx-api] ${signal} received, shutting down`);
    server.close(() => {
      void disconnect().then(() => process.exit(0));
    });
    // Do not let a hung connection hold the process open forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[invintelx-api] failed to start', err);
  process.exit(1);
});
