import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';
import type * as SetupModule from '../lib/setup.js';

/**
 * `SETUP_TOKEN` pinned by the operator, for a deploy where reading the
 * container's log is more awkward than injecting a secret. It needs its own
 * file because env.ts parses once per module graph, so a process cannot hold
 * both this configuration and the minted one.
 */
let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;
let setup: typeof SetupModule;

const PINNED = 'a-pinned-setup-token-long-enough';

const CREDENTIALS = {
  email: 'operator@invintelx.org',
  name: 'Operator',
  password: 'a-long-enough-password',
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_setup_pinned_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  process.env.FIRST_ADMIN_SETUP = 'token';
  process.env.SETUP_TOKEN = PINNED;

  db = await import('../db.js');
  await db.connect();
  await db.ensureIndexes();
  setup = await import('../lib/setup.js');

  const { createApp } = await import('../app.js');
  app = createApp();
}, 120_000);

afterAll(async () => {
  await db?.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await Promise.all([
    db.users().deleteMany({}),
    db.sessions().deleteMany({}),
    db.setupTokens().deleteMany({}),
  ]);
});

describe('a pinned SETUP_TOKEN', () => {
  it('is not printed, because the operator already has it', async () => {
    expect((await setup.prepareFirstAdminSetup()).kind).toBe('pinned');
  });

  it('claims the instance and refuses anything else', async () => {
    await setup.prepareFirstAdminSetup();

    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: 'not-the-token' })
      .expect(403);

    const response = await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: PINNED })
      .expect(201);
    expect(response.body.user.role).toBe('admin');
  });

  it('stops working once the instance has an account, env var or not', async () => {
    await setup.prepareFirstAdminSetup();
    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: PINNED })
      .expect(201);

    // Booting again with the variable still set must not re-arm it.
    expect((await setup.prepareFirstAdminSetup()).kind).toBe('claimed');
    expect(await db.setupTokens().countDocuments({})).toBe(0);
  });
});
