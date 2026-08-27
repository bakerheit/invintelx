import { beforeAll, describe, expect, it } from 'vitest';
import type { EnvResult } from './env.js';

/*
 * env.ts parses process.env at import and calls process.exit on a bad one, so
 * the module cannot be loaded until this process has an environment it accepts.
 * Everything below then goes through `parseEnv` against an environment of its
 * own making, which is the only way to assert on rules that only fire in
 * production without being deployed to one.
 */
let parseEnv: (source: NodeJS.ProcessEnv) => EnvResult;
let formatEnvProblems: (problems: string[], nodeEnv: string | undefined) => string;

const VALID_SECRET = 'test-secret-that-is-definitely-long-enough';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/unused';
  process.env.SESSION_SECRET = VALID_SECRET;

  ({ parseEnv, formatEnvProblems } = await import('./env.js'));
});

/** A minimal environment that parses, before whatever a test is varying. */
const base = (): NodeJS.ProcessEnv => ({
  MONGODB_URI: 'mongodb://localhost:27017/invintelx?replicaSet=rs0',
  SESSION_SECRET: VALID_SECRET,
});

function problemsFor(source: NodeJS.ProcessEnv): string[] {
  const result = parseEnv(source);
  return result.ok ? [] : result.problems;
}

describe('the environment schema', () => {
  it('accepts a minimal development environment', () => {
    const result = parseEnv(base());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.NODE_ENV).toBe('development');
    expect(result.env.PORT).toBe(3001);
  });

  it('reports every problem at once rather than the first', () => {
    const problems = problemsFor({ SESSION_SECRET: 'too-short' });

    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('MONGODB_URI');
    expect(problems.join('\n')).toContain('SESSION_SECRET');
  });
});

describe('MONGODB_URI', () => {
  it('accepts the mongodb+srv string a hosted cluster hands out', () => {
    const result = parseEnv({
      ...base(),
      MONGODB_URI: 'mongodb+srv://app:pw@cluster0.example.mongodb.net/?retryWrites=true&w=majority',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a bare hostname, which is what pasting half the string looks like', () => {
    const problems = problemsFor({ ...base(), MONGODB_URI: 'cluster0.example.mongodb.net' });

    expect(problems).toEqual([
      'MONGODB_URI: MONGODB_URI must be a mongodb:// or mongodb+srv:// connection string',
    ]);
  });
});

describe('MONGODB_DB', () => {
  it('defaults outside production, where one database is the only one there is', () => {
    const result = parseEnv(base());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.MONGODB_DB).toBe('invintelx');
  });

  /*
   * The whole point of the rule: staging and production run the same build
   * against the same cluster, so a staging deploy that forgot this variable
   * would default straight into production's collections.
   */
  it('is required in production rather than defaulting', () => {
    const problems = problemsFor({ ...base(), NODE_ENV: 'production' });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('MONGODB_DB');
    expect(problems[0]).toContain('must be set explicitly');
  });

  it('is satisfied in production by naming the database', () => {
    const result = parseEnv({
      ...base(),
      NODE_ENV: 'production',
      MONGODB_DB: 'invintelx_staging',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.MONGODB_DB).toBe('invintelx_staging');
  });
});

/*
 * The message is the whole of the user interface here. A container that exits at
 * boot leaves one paragraph in a deploy log, and whether that paragraph names the
 * variable and where its value comes from decides whether the next person fixes
 * it in a minute or an hour.
 */
describe('the message a refused environment prints', () => {
  it('lists every problem, one per line', () => {
    const text = formatEnvProblems(['MONGODB_DB: missing', 'SESSION_SECRET: too short'], 'test');

    expect(text).toContain('  - MONGODB_DB: missing');
    expect(text).toContain('  - SESSION_SECRET: too short');
  });

  it('points at .env.example outside production, where there is a checkout to open', () => {
    const text = formatEnvProblems(['MONGODB_URI: missing'], 'development');

    expect(text).toContain('.env.example');
    expect(text).not.toContain('docs/atlas.md');
  });

  /*
   * The production case has no checkout and no .env - the values arrive from the
   * host's secret store - so pointing there is a dead end for the one reader who
   * will actually hit this.
   */
  it('points at the Atlas runbook in production, where the values come from a secret store', () => {
    const text = formatEnvProblems(['MONGODB_DB: missing'], 'production');

    expect(text).toContain('docs/atlas.md');
    expect(text).not.toContain('.env.example');
  });
});
