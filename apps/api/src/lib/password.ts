import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id at defaults tuned for interactive login. @node-rs ships prebuilt
 * binaries, which keeps `pnpm install` from needing a C toolchain.
 */
const OPTIONS = {
  memoryCost: 19456, // 19 MiB - OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS);
  } catch {
    // A malformed hash in the database is a verification failure, not a 500.
    return false;
  }
}
