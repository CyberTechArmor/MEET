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

// Persisted, operator-editable subset of server settings.
// recommendedMax* are derived at startup from host resources and are
// never persisted.
export interface PersistedSettings {
  publicAccessEnabled: boolean;
  maxParticipantsPerMeeting: number;
  maxConcurrentMeetings: number;
  iframeAllowedDomains: string[];
}

export interface AdminCredentials {
  username: string;
  // scrypt-hashed password in "<saltHex>$<hashHex>" form (see auth.ts).
  // Empty string means no password configured yet (first-login mode).
  passwordHash: string;
  firstLoginDone: boolean;
}
