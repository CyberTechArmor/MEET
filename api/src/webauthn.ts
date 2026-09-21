// WebAuthn / passkey handlers.
//
// The MEET admin account is a single user; multiple passkeys are allowed.
// Challenges are kept in an in-memory Map with a short TTL — for the
// single-process API this is fine. (In a multi-instance deployment they'd
// need to live in Redis or a similar shared store.)
//
// Origin and rpID are derived from PUBLIC_BASE_URL at startup. This means
// the API has to be redeployed if you ever change the public hostname,
// but that's the same constraint the rest of the stack already has.

import * as crypto from 'crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import * as store from './store.js';
import type { Passkey } from './types.js';

const RP_NAME = 'MEET';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface RpConfig {
  rpID: string;
  origin: string[];
}

let rpConfig: RpConfig | null = null;

// Derive rpID + origin from PUBLIC_BASE_URL. For three-domain mode, allow
// the API URL and LiveKit URL as additional origins so a passkey
// registered on meet.<host> works from api.<host> too.
export function configureWebAuthn(publicBaseUrl: string, extraOrigins: string[] = []): void {
  if (!publicBaseUrl) {
    rpConfig = null;
    return;
  }
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    rpConfig = null;
    console.warn(`[webauthn] PUBLIC_BASE_URL is not a valid URL — passkeys disabled: ${publicBaseUrl}`);
    return;
  }
  const origins = [url.origin, ...extraOrigins.filter(Boolean)];
  rpConfig = { rpID: url.hostname, origin: origins };
  console.log(`[webauthn] rpID=${rpConfig.rpID} origins=${origins.join(',')}`);
}

export function isWebAuthnConfigured(): boolean {
  return rpConfig !== null;
}

function requireRp(): RpConfig {
  if (!rpConfig) {
    throw Object.assign(new Error('Passkeys are not configured (PUBLIC_BASE_URL not set)'), {
      statusCode: 503,
    });
  }
  return rpConfig;
}

// ────────────────────────── challenge cache ────────────────────────────

interface PendingChallenge {
  challenge: string;
  kind: 'register' | 'auth';
  expiresAt: number;
}

const challenges = new Map<string, PendingChallenge>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [key, val] of challenges) {
    if (val.expiresAt < now) challenges.delete(key);
  }
}

function rememberChallenge(kind: 'register' | 'auth', challenge: string): string {
  purgeExpired();
  const id = crypto.randomBytes(16).toString('hex');
  challenges.set(id, { challenge, kind, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return id;
}

function consumeChallenge(id: string, kind: 'register' | 'auth'): string | null {
  purgeExpired();
  const entry = challenges.get(id);
  if (!entry || entry.kind !== kind) return null;
  challenges.delete(id);
  return entry.challenge;
}

// ────────────────────────── registration ───────────────────────────────

export interface RegistrationOptionsResponse {
  ticket: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

export async function buildRegistrationOptions(
  username: string,
  userHandle: Buffer,
): Promise<RegistrationOptionsResponse> {
  const rp = requireRp();
  const existing = store.listPasskeys();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userID: new Uint8Array(userHandle),
    userName: username || 'admin',
    userDisplayName: username || 'admin',
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({
      id: bufferToBase64Url(p.credentialId),
      transports: p.transports as AuthenticatorTransportLike[],
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
  const ticket = rememberChallenge('register', options.challenge);
  return { ticket, options };
}

export interface RegistrationVerifyInput {
  ticket: string;
  label: string;
  response: RegistrationResponseJSON;
}

export async function verifyRegistration(
  input: RegistrationVerifyInput,
): Promise<{ id: string; label: string }> {
  const rp = requireRp();
  const expectedChallenge = consumeChallenge(input.ticket, 'register');
  if (!expectedChallenge) {
    throw Object.assign(new Error('Challenge expired or invalid'), { statusCode: 400 });
  }
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw Object.assign(new Error('Passkey registration failed verification'), { statusCode: 400 });
  }
  const info = verification.registrationInfo;
  const id = crypto.randomBytes(8).toString('hex');
  const label = (input.label || '').slice(0, 100) || 'Passkey';
  const passkey: Passkey = {
    id,
    credentialId: Buffer.from(info.credential.id, 'base64url'),
    publicKey: Buffer.from(info.credential.publicKey),
    counter: info.credential.counter,
    transports: (input.response.response.transports ?? []) as string[],
    label,
    createdAt: new Date(),
    lastUsedAt: null,
  };
  store.savePasskey(passkey);
  return { id, label };
}

// ─────────────────────────── authentication ────────────────────────────

export interface AuthOptionsResponse {
  ticket: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export async function buildAuthOptions(): Promise<AuthOptionsResponse> {
  const rp = requireRp();
  const existing = store.listPasskeys();
  if (existing.length === 0) {
    throw Object.assign(new Error('No passkeys registered'), { statusCode: 404 });
  }
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: existing.map((p) => ({
      id: bufferToBase64Url(p.credentialId),
      transports: p.transports as AuthenticatorTransportLike[],
    })),
    userVerification: 'preferred',
  });
  const ticket = rememberChallenge('auth', options.challenge);
  return { ticket, options };
}

export interface AuthVerifyInput {
  ticket: string;
  response: AuthenticationResponseJSON;
}

// On success the caller (index.ts) is responsible for issuing a session
// token. We just verify the assertion and bump the counter.
export async function verifyAuth(input: AuthVerifyInput): Promise<{ verified: true }> {
  const rp = requireRp();
  const expectedChallenge = consumeChallenge(input.ticket, 'auth');
  if (!expectedChallenge) {
    throw Object.assign(new Error('Challenge expired or invalid'), { statusCode: 400 });
  }
  const credentialId = Buffer.from(input.response.id, 'base64url');
  const passkey = store.findPasskeyByCredentialId(credentialId);
  if (!passkey) {
    throw Object.assign(new Error('Unknown passkey'), { statusCode: 401 });
  }
  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: bufferToBase64Url(passkey.credentialId),
      publicKey: new Uint8Array(passkey.publicKey),
      counter: passkey.counter,
      transports: passkey.transports as AuthenticatorTransportLike[],
    },
    requireUserVerification: false,
  });
  if (!verification.verified) {
    throw Object.assign(new Error('Passkey assertion failed verification'), { statusCode: 401 });
  }
  passkey.counter = verification.authenticationInfo.newCounter;
  passkey.lastUsedAt = new Date();
  store.savePasskey(passkey);
  return { verified: true };
}

// ─────────────────────────────── helpers ───────────────────────────────

function bufferToBase64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

// @simplewebauthn types accept a permissive `AuthenticatorTransportFuture`
// alias; we re-declare the minimal shape we need so this file doesn't have
// to import the alias and pin its version.
type AuthenticatorTransportLike =
  | 'ble'
  | 'cable'
  | 'hybrid'
  | 'internal'
  | 'nfc'
  | 'smart-card'
  | 'usb';
