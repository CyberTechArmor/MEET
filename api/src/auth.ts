// Password hashing for the admin account.
//
// We use Node's built-in scrypt (memory-hard KDF, comparable in strength to
// bcrypt) rather than pulling in bcryptjs/bcrypt. No native compile, no new
// dependency. Stored format is "<saltHex>$<hashHex>" — the legacy plaintext
// column on admin_credentials.password is migrated lazily on first read in
// index.ts at startup.
//
// scrypt parameters: N=16384, r=8, p=1 (Node defaults; ~64 MB, ~50 ms).
// Adequate for an admin login that runs at most a few times per session.

import * as crypto from 'crypto';

const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return `${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  const sep = stored.indexOf('$');
  if (sep < 0) return false;
  const salt = stored.slice(0, sep);
  const expectedHex = stored.slice(sep + 1);
  if (!salt || !expectedHex) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;

  const actual = crypto.scryptSync(password, salt, KEYLEN);
  return crypto.timingSafeEqual(expected, actual);
}
