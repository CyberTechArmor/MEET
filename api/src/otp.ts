// One-time sign-in codes.
//
// Codes live in an in-memory Map keyed by an opaque ticket, mirroring the
// WebAuthn challenge cache: single-process API, short TTL, nothing worth
// persisting. Only the sha256 of (ticket + code) is kept so a heap dump
// doesn't hand out live codes.
//
// Brute-force posture: 6 digits, 5 attempts per code, one live code per
// purpose (issuing a new one invalidates the previous), and a minimum
// interval between sends. Worst case an attacker gets 5 guesses in 1e6 per
// 30 seconds — and every request emails the real admin.

import * as crypto from 'crypto';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_TTL_MINUTES = OTP_TTL_MS / 60_000;
const MAX_ATTEMPTS = 5;
const MIN_SEND_INTERVAL_MS = 30 * 1000;

export type OtpKind = 'login' | 'verify';

interface PendingOtp {
  kind: OtpKind;
  hash: Buffer;
  expiresAt: number;
  attempts: number;
}

const pending = new Map<string, PendingOtp>();
const lastIssuedAt: Record<OtpKind, number> = { login: 0, verify: 0 };

function hashOf(ticket: string, code: string): Buffer {
  return crypto.createHash('sha256').update(`${ticket}:${code}`).digest();
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (v.expiresAt < now) pending.delete(k);
  }
}

export class OtpError extends Error {
  statusCode: number;
  retryAfterSeconds?: number;
  constructor(message: string, statusCode: number, retryAfterSeconds?: number) {
    super(message);
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function generateCode(): string {
  // crypto.randomInt is uniform; pad so leading zeros are preserved.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export interface IssuedOtp {
  ticket: string;
  code: string;
  expiresAt: Date;
}

// Mint a new code. Throws 429 if one was issued for this purpose less than
// MIN_SEND_INTERVAL_MS ago. Any previous live code of the same kind is
// invalidated.
export function issue(kind: OtpKind): IssuedOtp {
  purgeExpired();
  const now = Date.now();
  const since = now - lastIssuedAt[kind];
  if (since < MIN_SEND_INTERVAL_MS) {
    const wait = Math.ceil((MIN_SEND_INTERVAL_MS - since) / 1000);
    throw new OtpError(`Please wait ${wait}s before requesting another code`, 429, wait);
  }
  for (const [k, v] of pending) {
    if (v.kind === kind) pending.delete(k);
  }
  const ticket = crypto.randomBytes(16).toString('hex');
  const code = generateCode();
  const expiresAt = now + OTP_TTL_MS;
  pending.set(ticket, { kind, hash: hashOf(ticket, code), expiresAt, attempts: 0 });
  lastIssuedAt[kind] = now;
  return { ticket, code, expiresAt: new Date(expiresAt) };
}

// Called when the email could not be sent: drop the code and lift the
// send-interval lock so the admin can retry after fixing the config.
export function discard(ticket: string, kind: OtpKind): void {
  pending.delete(ticket);
  lastIssuedAt[kind] = 0;
}

// Verify and consume. Throws OtpError on any failure; returns on success.
export function consume(ticket: string, code: string, kind: OtpKind): void {
  purgeExpired();
  const entry = pending.get(ticket);
  if (!entry || entry.kind !== kind) {
    throw new OtpError('Code expired or invalid — request a new one', 400);
  }
  entry.attempts += 1;
  const normalized = String(code ?? '').replace(/\D/g, '');
  const ok = normalized.length === 6
    && crypto.timingSafeEqual(entry.hash, hashOf(ticket, normalized));
  if (ok) {
    pending.delete(ticket);
    return;
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    pending.delete(ticket);
    throw new OtpError('Too many incorrect attempts — request a new code', 429);
  }
  throw new OtpError(`Incorrect code (${MAX_ATTEMPTS - entry.attempts} attempts left)`, 401);
}

// Test-only / reset helper.
export function clearAll(): void {
  pending.clear();
  lastIssuedAt.login = 0;
  lastIssuedAt.verify = 0;
}
