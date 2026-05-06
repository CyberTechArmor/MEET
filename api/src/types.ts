// Shared types for the persistence layer + the request handlers in
// index.ts. Extracted out of index.ts so db.ts and store.ts can import
// them without pulling in the express server.

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  keyHash: string;
  permissions: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret: string;
  createdAt: Date;
  lastTriggeredAt: Date | null;
  failureCount: number;
}

export interface AdminSession {
  token: string;
  createdAt: Date;
  expiresAt: Date;
}

// Mirrors the frontend VideoQualityPreset union. The backend doesn't
// translate these into LiveKit codec / resolution parameters — that's the
// frontend's job — it only passes the chosen preset back to the client
// via /api/token, with per-room metadata taking precedence over the
// platform default.
export type VideoQualityPreset = 'auto' | 'high' | 'max' | 'balanced' | 'low';
export const VIDEO_QUALITY_PRESET_VALUES: readonly VideoQualityPreset[] = [
  'auto', 'high', 'max', 'balanced', 'low',
];
export function isValidVideoQuality(s: string): s is VideoQualityPreset {
  return (VIDEO_QUALITY_PRESET_VALUES as readonly string[]).includes(s);
}

// Persisted, operator-editable subset of server settings.
// recommendedMax* are derived at startup from host resources and are
// never persisted.
export interface PersistedSettings {
  publicAccessEnabled: boolean;
  maxParticipantsPerMeeting: number;
  maxConcurrentMeetings: number;
  iframeAllowedDomains: string[];
  defaultVideoQuality: VideoQualityPreset;
}

export interface AdminCredentials {
  username: string;
  // scrypt-hashed password in "<saltHex>$<hashHex>" form (see auth.ts).
  // Empty string means no password configured yet (first-login mode).
  passwordHash: string;
  firstLoginDone: boolean;
  // Stable random bytes (16) used as the WebAuthn user handle. Created on
  // first read if missing — never changes after that, otherwise registered
  // passkeys would be invalidated.
  userHandle: Buffer;
}

// A registered WebAuthn (passkey) credential. credentialId is the binary
// identifier the authenticator returns; we store and compare it as raw
// bytes. publicKey is the COSE-encoded credential public key from the
// attestation. counter increments per assertion to detect cloned
// authenticators (some authenticators always return 0).
export interface Passkey {
  id: string;
  credentialId: Buffer;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}
