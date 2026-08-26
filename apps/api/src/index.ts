import { env } from './env.js';
import { connect, disconnect, ensureIndexes } from './db.js';
import { createApp } from './app.js';
import { prepareFirstAdminSetup, type SetupAnnouncement } from './lib/setup.js';

const RULE = '─'.repeat(62);

/**
 * The minted token exists nowhere but here, so this log line is the whole
 * delivery mechanism. It is worth the shouting: an operator who scrolls past it
 * has to restart the process to get another one.
 */
function announceSetup(setup: SetupAnnouncement): void {
  if (setup.kind === 'claimed') return;

  console.log(`[invintelx-api] ${RULE}`);
  if (setup.kind === 'open') {
    console.log('[invintelx-api] FIRST_ADMIN_SETUP=open and this instance has no accounts.');
    console.log('[invintelx-api] The next person to register becomes the administrator —');
    console.log('[invintelx-api] anyone who reaches this instance before you do owns it.');
  } else if (setup.kind === 'pinned') {
    console.log('[invintelx-api] This instance has no accounts yet.');
    console.log('[invintelx-api] Register with the SETUP_TOKEN you configured to become the');
    console.log('[invintelx-api] administrator. It stops working once an account exists.');
  } else {
    console.log('[invintelx-api] This instance has no accounts yet. To become its administrator,');
    console.log('[invintelx-api] register and give this setup token:');
    console.log(`[invintelx-api]     ${setup.token}`);
    console.log('[invintelx-api] Shown once per boot, replaced on the next one, and dead as soon');
    console.log('[invintelx-api] as it has made an administrator.');
  }
  console.log(`[invintelx-api] ${RULE}`);
}

async function main(): Promise<void> {
  await connect();
  await ensureIndexes();
  announceSetup(await prepareFirstAdminSetup());

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
