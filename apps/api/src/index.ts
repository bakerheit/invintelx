import { env } from './env.js';
import { connect, disconnect, ensureIndexes } from './db.js';
import { createApp } from './app.js';
import { installProcessErrorHandlers } from './lib/errorTracking.js';
import { logger } from './lib/logger.js';
import { prepareFirstAdminSetup, type SetupAnnouncement } from './lib/setup.js';
import { MigrationError, runMigrations } from './migrations/index.js';
import { VERSION } from './version.js';

const RULE = '─'.repeat(62);

/**
 * The minted token exists nowhere but here, so this log line is the whole
 * delivery mechanism. It is worth the shouting: an operator who scrolls past it
 * has to restart the process to get another one.
 *
 * The one thing in this process that stays on `console` rather than moving to
 * the structured logger, and for two reasons that both matter. It is a banner
 * addressed to a person, not a record addressed to a machine — sixty dashes as
 * a JSON `msg` is not an improvement. And the logger redacts anything that
 * looks like a token, correctly and by design, which would eat the single
 * secret in this codebase that is *meant* to be printed.
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
  /*
   * Before anything that could throw asynchronously, and from here rather than
   * from `createApp`, because these are process-global: installing them in the
   * app factory would change how every test file in the suite dies.
   */
  installProcessErrorHandlers();

  await connect();
  // Before anything reads or writes application data, and before the server
  // listens. A boot that gets past this is a boot whose code and database agree
  // about the shape; one that does not must not serve a single request.
  await runMigrations();
  await ensureIndexes();
  announceSetup(await prepareFirstAdminSetup());

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        event: 'listening',
        port: env.PORT,
        nodeEnv: env.NODE_ENV,
        version: VERSION,
        url: `http://localhost:${String(env.PORT)}`,
      },
      'listening',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ event: 'shutdown', signal }, 'signal received, shutting down');
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
  /*
   * A migration failure is an operator's problem, not a programmer's, and its
   * message is written for one. A stack trace above it would only bury the
   * sentence that says what to do.
   */
  if (err instanceof MigrationError) {
    console.error(`[invintelx-api] ${RULE}`);
    console.error('[invintelx-api] Refusing to start: the database is not in a shape this build');
    console.error('[invintelx-api] can safely use.');
    console.error('[invintelx-api]');
    for (const line of err.message.split('\n')) console.error(`[invintelx-api] ${line}`);
    console.error(`[invintelx-api] ${RULE}`);
    process.exit(1);
  }

  logger.fatal({ event: 'boot_failed', err }, 'failed to start');
  process.exit(1);
});
