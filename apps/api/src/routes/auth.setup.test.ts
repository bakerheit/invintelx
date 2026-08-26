import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import type { Express } from 'express';
import type * as DbModule from '../db.js';
import type * as SetupModule from '../lib/setup.js';

/**
 * The default bootstrap: an instance is not owned by whoever reaches it first.
 *
 * These run against a real mongod because the one-shot guarantee is a single
 * atomic delete in the database. A mock would agree that spending a token twice
 * is fine, which is the one thing worth proving here.
 */
let replSet: MongoMemoryReplSet;
let app: Express;
let db: typeof DbModule;
let setup: typeof SetupModule;

const CREDENTIALS = {
  email: 'operator@invintelx.org',
  name: 'Operator',
  password: 'a-long-enough-password',
};

/** Boot the instance the way `index.ts` does, and keep the token it printed. */
async function bootUnclaimedInstance(): Promise<string> {
  const announcement = await setup.prepareFirstAdminSetup();
  if (announcement.kind !== 'minted') {
    throw new Error(`expected a minted setup token, got ${announcement.kind}`);
  }
  return announcement.token;
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = 'invintelx_setup_test';
  process.env.SESSION_SECRET = 'test-secret-that-is-definitely-long-enough';
  // Named rather than left implicit: this file is about what a self-hosted
  // instance does out of the box, and out of the box is the token bootstrap.
  process.env.FIRST_ADMIN_SETUP = 'token';
  delete process.env.SETUP_TOKEN;

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

describe('first-admin setup', () => {
  it('refuses to create the first account without the setup token', async () => {
    await bootUnclaimedInstance();

    const response = await request(app).post('/api/auth/register').send(CREDENTIALS).expect(403);

    expect(response.body.error.fields.setupToken).toBeDefined();
    expect(await db.users().countDocuments({})).toBe(0);
  });

  it('refuses a wrong setup token and leaves the real one usable', async () => {
    const token = await bootUnclaimedInstance();

    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: 'not-the-token' })
      .expect(403);
    expect(await db.users().countDocuments({})).toBe(0);

    const accepted = await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: token })
      .expect(201);
    expect(accepted.body.user.role).toBe('admin');
  });

  it('refuses registration when no token was ever minted', async () => {
    // No boot step at all: the instance is reachable but nothing has claimed it
    // and nothing has offered a way to. It has to fail closed.
    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: 'anything-at-all' })
      .expect(403);
    expect(await db.users().countDocuments({})).toBe(0);
  });

  it('signs the administrator in, the same as any other registration', async () => {
    const token = await bootUnclaimedInstance();

    const response = await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: token })
      .expect(201);

    const cookies = response.headers['set-cookie'];
    const header = Array.isArray(cookies) ? cookies[0] : cookies;
    expect(header).toBeDefined();

    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', (header ?? '').split(';')[0] ?? '')
      .expect(200);
    expect(me.body.user.role).toBe('admin');
  });

  it('spends the token once, so it cannot mint a second administrator', async () => {
    const token = await bootUnclaimedInstance();
    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: token })
      .expect(201);

    expect(await db.setupTokens().countDocuments({})).toBe(0);

    // Take the instance back to having no accounts without rebooting it. The
    // token is spent, so it is not a way back in.
    await db.users().deleteMany({});
    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: token })
      .expect(403);
  });

  it('stops asking for a token once the instance has an administrator', async () => {
    const token = await bootUnclaimedInstance();
    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: token })
      .expect(201);

    const second = await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, email: 'colleague@invintelx.org' })
      .expect(201);
    expect(second.body.user.role).toBe('member');
  });

  it('never stores the token itself, only a hash of it', async () => {
    const token = await bootUnclaimedInstance();

    const stored = await db.setupTokens().findOne({});
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('mints a fresh token per boot and retires the previous one', async () => {
    const first = await bootUnclaimedInstance();
    const second = await bootUnclaimedInstance();
    expect(second).not.toBe(first);

    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: first })
      .expect(403);
    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: second })
      .expect(201);
  });

  it('clears a live token at boot once the instance has been claimed', async () => {
    await bootUnclaimedInstance();
    await db.users().insertOne({
      _id: new ObjectId(),
      email: 'someone@invintelx.org',
      name: 'Someone',
      passwordHash: 'x',
      role: 'admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const announcement = await setup.prepareFirstAdminSetup();
    expect(announcement.kind).toBe('claimed');
    expect(await db.setupTokens().countDocuments({})).toBe(0);
  });
});

describe('GET /api/auth/setup', () => {
  it('tells an unauthenticated caller that the instance needs claiming', async () => {
    await bootUnclaimedInstance();

    const response = await request(app).get('/api/auth/setup').expect(200);
    expect(response.body).toEqual({ firstAccount: true, setupTokenRequired: true });
  });

  it('reports a claimed instance once an account exists', async () => {
    const token = await bootUnclaimedInstance();
    await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, setupToken: token })
      .expect(201);

    const response = await request(app).get('/api/auth/setup').expect(200);
    expect(response.body).toEqual({ firstAccount: false, setupTokenRequired: false });
  });
});
