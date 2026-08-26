/**
 * Runs a real mongod as a single-node replica set on port 27017, without
 * Docker.
 *
 * docker-compose remains the documented path. This exists because Docker
 * Desktop is not always healthy, and "the database will not start" should not
 * be the thing that stops someone contributing. It downloads a genuine mongod
 * binary on first run and keeps data in .mongo-data, so it behaves like the
 * compose service rather than like a test double.
 *
 * Run with: pnpm db:local
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const PORT = 27017;
const DB_PATH = resolve(process.cwd(), '.mongo-data');

mkdirSync(DB_PATH, { recursive: true });

console.log('Starting mongod (first run downloads the binary, this can take a minute)...');

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger' },
  instanceOpts: [{ port: PORT, dbPath: DB_PATH, storageEngine: 'wiredTiger' }],
});

const uri = `mongodb://localhost:${PORT}/invintelx?replicaSet=rs0`;
console.log(`\n  mongod ready on port ${PORT}`);
console.log(`  data:  ${DB_PATH}`);
console.log(`  uri:   ${uri}`);
console.log('\nLeave this running. Ctrl-C to stop.\n');

const shutdown = async () => {
  console.log('\nStopping mongod...');
  await replSet.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
