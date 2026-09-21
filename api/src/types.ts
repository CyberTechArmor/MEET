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
  // 'local' for the built-in account (password / passkey / email code),
  // 'ldap:<dn>' for a directory admin. Decides who may disable the local
  // account.
  principal: string;
  displayName: string;
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
  // Set by a directory (LDAP) admin: every local credential — password,
  // passkeys, emailed codes — stops working until re-enabled.
  localDisabled: boolean;
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

// Outbound email (SMTP) configuration used for one-time sign-in codes.
//
// `verified` flips to true only after the admin completes a test round
// trip (a code is emailed to adminEmail and typed back in). Password login
// is disabled from that moment on: an unverified SMTP config never locks
// anyone out. Editing any transport field resets `verified` to false.
export interface SmtpSettings {
  host: string;
  port: number;
  // true = implicit TLS (usually port 465); false = plain/STARTTLS (587/25)
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  // Where sign-in codes are delivered. Single admin account → single address.
  adminEmail: string;
  verified: boolean;
  verifiedAt: string | null;
}

// Directory (LDAP / LDAPS) integration. Off by default. Two independent
// uses: gate the meeting frontend behind a directory sign-in
// (requireForFrontend), and let selected directory users into the admin
// panel (adminsEnabled + rows in ldap_admins).
export interface LdapSettings {
  enabled: boolean;
  // ldap://host:389 or ldaps://host:636
  url: string;
  // Upgrade an ldap:// connection with StartTLS before binding.
  startTls: boolean;
  tlsRejectUnauthorized: boolean;
  // Optional PEM bundle for a private CA.
  caCert: string;
  // Service account used to search for users. Empty = anonymous.
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  // RFC 4515 filter with {{username}} placeholder (value is escaped).
  userFilter: string;
  // Filter for the admin picker with {{q}} placeholder (value is escaped).
  searchFilter: string;
  usernameAttribute: string;
  displayNameAttribute: string;
  emailAttribute: string;
  timeoutMs: number;
  requireForFrontend: boolean;
  adminsEnabled: boolean;
}

// A directory user granted access to the admin panel.
export interface LdapAdmin {
  id: string;
  dn: string;
  username: string;
  displayName: string;
  email: string;
  addedBy: string;
  createdAt: Date;
  lastLoginAt: Date | null;
}

// Frontend (participant) session issued after a directory sign-in when
// requireForFrontend is on.
export interface UserSession {
  token: string;
  dn: string;
  username: string;
  displayName: string;
  createdAt: Date;
  expiresAt: Date;
}
