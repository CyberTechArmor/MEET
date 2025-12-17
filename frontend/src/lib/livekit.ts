import {
  Room,
  RoomOptions,
  VideoPresets,
  VideoCodec,
  ScreenSharePresets,
  TrackPublishDefaults,
  VideoCaptureOptions,
} from 'livekit-client';

/**
 * Video Quality Preset Configuration
 *
 * MEET supports multiple video quality presets optimized for different use cases:
 * - 'auto': Adaptive quality based on network conditions (recommended)
 * - 'high': Full HD (1080p) with high bitrate for quality-focused calls
 * - 'max': 4K Ultra HD for maximum quality (requires good network)
 * - 'balanced': 720p balanced between quality and bandwidth
 * - 'low': 360p for low-bandwidth situations
 */
export type VideoQualityPreset = 'auto' | 'high' | 'max' | 'balanced' | 'low';

/**
 * Video quality configuration interface
 */
export interface VideoQualityConfig {
  /** Maximum capture resolution */
  captureResolution: typeof VideoPresets[keyof typeof VideoPresets];
  /** Simulcast layers for adaptive streaming */
  simulcastLayers: typeof VideoPresets[keyof typeof VideoPresets][];
  /** Preferred video codec */
  videoCodec: VideoCodec;
  /** Screen share preset */
  screenSharePreset: typeof ScreenSharePresets[keyof typeof ScreenSharePresets];
  /** Enable DTX (Discontinuous Transmission) for audio */
  audioDtx: boolean;
  /** Enable RED (Redundant Encoding) for audio */
  audioRed: boolean;
}

/**
 * Video quality presets configuration
 */
export const VIDEO_QUALITY_PRESETS: Record<VideoQualityPreset, VideoQualityConfig> = {
  /**
   * Maximum quality (4K UHD)
   * Best for: High-bandwidth connections, quality-critical presentations
   * Resolution: 2160p (3840x2160)
   * Bitrate: Up to 8 Mbps
   */
  max: {
    captureResolution: VideoPresets.h2160,
    simulcastLayers: [VideoPresets.h360, VideoPresets.h720, VideoPresets.h1080],
    videoCodec: 'vp9',
    screenSharePreset: ScreenSharePresets.h1080fps30,
    audioDtx: true,
    audioRed: true,
  },
  /**
   * High quality (Full HD)
   * Best for: Standard video calls with good network
   * Resolution: 1080p (1920x1080)
   * Bitrate: Up to 3 Mbps
   */
  high: {
    captureResolution: VideoPresets.h1080,
    simulcastLayers: [VideoPresets.h360, VideoPresets.h540, VideoPresets.h720],
    videoCodec: 'vp9',
    screenSharePreset: ScreenSharePresets.h1080fps30,
    audioDtx: true,
    audioRed: true,
  },
  /**
   * Adaptive quality (recommended)
   * Best for: Most use cases, automatically adapts to network conditions
   * Resolution: 1080p capture with dynamic adjustment
   * Bitrate: Adaptive based on network
   */
  auto: {
    captureResolution: VideoPresets.h1080,
    simulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
    videoCodec: 'vp9',
    screenSharePreset: ScreenSharePresets.h1080fps15,
    audioDtx: true,
    audioRed: true,
  },
  /**
   * Balanced quality (HD)
   * Best for: Average network conditions
   * Resolution: 720p (1280x720)
   * Bitrate: Up to 1.5 Mbps
   */
  balanced: {
    captureResolution: VideoPresets.h720,
    simulcastLayers: [VideoPresets.h180, VideoPresets.h360],
    videoCodec: 'vp8',
    screenSharePreset: ScreenSharePresets.h720fps15,
    audioDtx: true,
    audioRed: true,
  },
  /**
   * Low bandwidth mode
   * Best for: Poor network conditions, mobile data
   * Resolution: 360p (640x360)
   * Bitrate: Up to 500 Kbps
   */
  low: {
    captureResolution: VideoPresets.h360,
    simulcastLayers: [VideoPresets.h90, VideoPresets.h180],
    videoCodec: 'vp8',
    screenSharePreset: ScreenSharePresets.h720fps5,
    audioDtx: true,
    audioRed: true,
  },
};

/** Current video quality preset (can be changed at runtime) */
let currentQualityPreset: VideoQualityPreset = 'high';

/**
 * Set the video quality preset
 * @param preset - The quality preset to use
 */
export function setVideoQualityPreset(preset: VideoQualityPreset): void {
  currentQualityPreset = preset;
}

/**
 * Get the current video quality preset
 * @returns The current quality preset
 */
export function getVideoQualityPreset(): VideoQualityPreset {
  return currentQualityPreset;
}

/**
 * Get the configuration for a specific quality preset
 * @param preset - The quality preset
 * @returns The quality configuration
 */
export function getQualityConfig(preset?: VideoQualityPreset): VideoQualityConfig {
  return VIDEO_QUALITY_PRESETS[preset ?? currentQualityPreset];
}

// API configuration - dynamically determine URLs based on current hostname
function getApiUrl(): string {
  // If explicitly set via env var (non-empty), use that
  const envUrl = import.meta.env.VITE_API_URL;
  if (envUrl && envUrl.trim() !== '') {
    return envUrl;
  }

  // Otherwise, derive from current location for dynamic hostname support
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;

  // If running behind reverse proxy (port 80/443), use relative URL
  if (window.location.port === '' || window.location.port === '80' || window.location.port === '443') {
    return '';  // Use relative URLs - Caddy will proxy /api/* to the API server
  }

  // Demo mode: API runs on port 8080 on same host
  return `${protocol}//${hostname}:8080`;
}

function getLiveKitWsUrl(): string {
  // If explicitly set via env var (non-empty), use that
  const envUrl = import.meta.env.VITE_LIVEKIT_URL;
  if (envUrl && envUrl.trim() !== '') {
    return envUrl;
  }

  // Otherwise, derive from current location for dynamic hostname support
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostname = window.location.hostname;
  const port = window.location.port;

  // If running behind reverse proxy (port 80/443), use proxied path through Caddy
  // This ensures WebSocket goes through SSL on the same port
  if (port === '' || port === '80' || port === '443') {
    // Use /livekit path which Caddy proxies to LiveKit server
    return `${wsProtocol}//${hostname}/livekit`;
  }

  // Demo mode: LiveKit runs on port 7880 on same host
  return `${wsProtocol}//${hostname}:7880`;
}

const API_URL = getApiUrl();
const LIVEKIT_URL = getLiveKitWsUrl();

// Device ID for unique participant identification
const DEVICE_ID_KEY = 'meet_device_id';
const SESSION_KEY = 'meet_session';

/**
 * Get or generate a unique device ID
 */
export function getDeviceId(): string {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    // Generate a random device ID
    deviceId = `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

/**
 * Session data for auto-rejoin
 */
export interface SessionData {
  roomCode: string;
  displayName: string;
  timestamp: number;
  isHost?: boolean;
}

/**
 * Save session for auto-rejoin on refresh
 */
export function saveSession(roomCode: string, displayName: string, isHost: boolean = false): void {
  const session: SessionData = {
    roomCode,
    displayName,
    timestamp: Date.now(),
    isHost,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/**
 * Get saved session if valid (not older than 1 hour)
 */
export function getSavedSession(): SessionData | null {
  try {
    const data = sessionStorage.getItem(SESSION_KEY);
    if (!data) return null;

    const session: SessionData = JSON.parse(data);
    const oneHour = 60 * 60 * 1000;

    // Session expires after 1 hour
    if (Date.now() - session.timestamp > oneHour) {
      clearSession();
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

/**
 * Clear saved session
 */
export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

export interface TokenResponse {
  token: string;
  roomName: string;
  participantName: string;
  participantIdentity: string;
  isHost: boolean;
}

export interface RoomCodeResponse {
  roomCode: string;
}

/**
 * Fetch a token for joining a LiveKit room
 * Uses deviceId for unique identity while keeping displayName for the visible name
 */
export async function getToken(roomName: string, participantName: string): Promise<TokenResponse> {
  const deviceId = getDeviceId();

  const response = await fetch(`${API_URL}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      roomName,
      participantName,
      deviceId,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get token' }));
    throw new Error(error.error || 'Failed to get token');
  }

  return response.json();
}

/**
 * Generate a random room code
 */
export async function generateRoomCode(): Promise<string> {
  const response = await fetch(`${API_URL}/api/room-code`);

  if (!response.ok) {
    // Fallback to client-side generation
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return code;
  }

  const data: RoomCodeResponse = await response.json();
  return data.roomCode;
}

/**
 * Create a new LiveKit room instance with optimized settings
 *
 * Creates a Room configured with the current video quality preset.
 * By default, uses 'high' quality (1080p) for the best balance of quality and compatibility.
 *
 * Features:
 * - Adaptive streaming: Automatically adjusts quality based on network conditions
 * - Dynacast: Selective forwarding to save bandwidth when tracks aren't being viewed
 * - Simulcast: Multiple quality layers for optimal delivery to each participant
 * - VP9 codec: Better compression and quality at lower bitrates
 *
 * @param qualityPreset - Optional quality preset override (defaults to current preset)
 * @returns Configured Room instance
 *
 * @example
 * ```typescript
 * // Create room with default (high) quality
 * const room = createRoom();
 *
 * // Create room with maximum quality
 * const room = createRoom('max');
 *
 * // Create room with adaptive quality
 * const room = createRoom('auto');
 * ```
 */
export function createRoom(qualityPreset?: VideoQualityPreset): Room {
  const config = getQualityConfig(qualityPreset);

  const videoCaptureDefaults: VideoCaptureOptions = {
    resolution: config.captureResolution.resolution,
    facingMode: 'user',
  };

  const publishDefaults: TrackPublishDefaults = {
    // Video settings
    videoSimulcastLayers: config.simulcastLayers,
    videoCodec: config.videoCodec,
    // Screen share settings
    screenShareEncoding: config.screenSharePreset.encoding,
    screenShareSimulcastLayers: [
      ScreenSharePresets.h720fps15,
      ScreenSharePresets.h1080fps15,
    ],
    // Audio settings for better quality
    dtx: config.audioDtx,
    red: config.audioRed,
    // Force relay for better NAT traversal
    forceStereo: false,
    // Enable simulcast for all tracks
    simulcast: true,
    // Backup codec for compatibility
    backupCodec: { codec: 'vp8', encoding: VideoPresets.h720.encoding },
  };

  const roomOptions: RoomOptions = {
    // Adaptive streaming automatically adjusts quality based on network
    adaptiveStream: true,
    // Dynacast reduces bandwidth by not publishing to subscribers who aren't watching
    dynacast: true,
    // Video capture configuration
    videoCaptureDefaults,
    // Publishing configuration
    publishDefaults,
    // Audio capture defaults with noise suppression
    audioCaptureDefaults: {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
    },
    // Reconnection policy
    disconnectOnPageLeave: true,
  };

  return new Room(roomOptions);
}

/**
 * Get available video quality presets with their descriptions
 * @returns Array of preset information
 */
export function getAvailableQualityPresets(): Array<{
  preset: VideoQualityPreset;
  name: string;
  description: string;
  resolution: string;
}> {
  return [
    {
      preset: 'max',
      name: '4K Ultra HD',
      description: 'Maximum quality for high-bandwidth connections',
      resolution: '2160p (3840×2160)',
    },
    {
      preset: 'high',
      name: 'Full HD',
      description: 'Excellent quality for most video calls',
      resolution: '1080p (1920×1080)',
    },
    {
      preset: 'auto',
      name: 'Adaptive',
      description: 'Automatically adjusts based on network conditions',
      resolution: 'Up to 1080p',
    },
    {
      preset: 'balanced',
      name: 'HD',
      description: 'Good balance between quality and bandwidth',
      resolution: '720p (1280×720)',
    },
    {
      preset: 'low',
      name: 'Low Bandwidth',
      description: 'Optimized for poor network conditions',
      resolution: '360p (640×360)',
    },
  ];
}

/**
 * Get the LiveKit server URL
 */
export function getLiveKitUrl(): string {
  return LIVEKIT_URL;
}

/**
 * Format room code for display (add dash in middle)
 */
export function formatRoomCode(code: string): string {
  const clean = code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  if (clean.length <= 3) return clean;
  return `${clean.slice(0, 3)}-${clean.slice(3, 6)}`;
}

/**
 * Parse room code from input (remove dashes and spaces)
 */
export function parseRoomCode(input: string): string {
  return input.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 6);
}

// ============================================================================
// JOIN LINK API
// ============================================================================

/**
 * Join link parameters parsed from URL
 */
export interface JoinLinkParams {
  /** Room code to join */
  room: string | null;
  /** Display name for the participant */
  name: string | null;
  /** Whether to auto-join when both room and name are provided */
  autojoin: boolean;
  /** Video quality preset to use */
  quality: VideoQualityPreset | null;
}

/**
 * Options for generating a join link
 */
export interface JoinLinkOptions {
  /** Room code (required) */
  room: string;
  /** Pre-filled display name (optional) */
  name?: string;
  /** Auto-join when link is opened (default: true if name is provided) */
  autojoin?: boolean;
  /** Video quality preset (optional) */
  quality?: VideoQualityPreset;
}

/**
 * Parse join link parameters from the current URL
 *
 * Supported URL formats:
 * - `?room=ABCDEF` - Pre-fill room code only
 * - `?room=ABCDEF&name=John` - Pre-fill both, prompt to join
 * - `?room=ABCDEF&name=John&autojoin=true` - Auto-join immediately
 * - `?room=ABCDEF&name=John&quality=max` - Join with specific quality
 *
 * @returns Parsed join link parameters
 *
 * @example
 * ```typescript
 * const params = parseJoinLink();
 * if (params.room && params.name && params.autojoin) {
 *   // Auto-join the meeting
 *   await connect(params.room, params.name);
 * }
 * ```
 */
export function parseJoinLink(): JoinLinkParams {
  const urlParams = new URLSearchParams(window.location.search);

  const room = urlParams.get('room');
  const name = urlParams.get('name');
  const autojoinParam = urlParams.get('autojoin');
  const qualityParam = urlParams.get('quality');

  // Parse autojoin - defaults to true if name is provided
  let autojoin = name !== null;
  if (autojoinParam !== null) {
    autojoin = autojoinParam === 'true' || autojoinParam === '1';
  }

  // Validate quality preset
  let quality: VideoQualityPreset | null = null;
  if (qualityParam && ['auto', 'high', 'max', 'balanced', 'low'].includes(qualityParam)) {
    quality = qualityParam as VideoQualityPreset;
  }

  return {
    room: room ? parseRoomCode(room) : null,
    name: name ? name.slice(0, 50) : null,
    autojoin,
    quality,
  };
}

/**
 * Generate a join link URL for a meeting
 *
 * Creates a shareable URL that can be used to join a meeting directly.
 * When the link is opened, it will pre-fill the room code and optionally
 * the display name, and can auto-join the meeting.
 *
 * @param options - Join link options
 * @returns Full URL for joining the meeting
 *
 * @example
 * ```typescript
 * // Basic join link (user enters their name)
 * const link = generateJoinLink({ room: 'ABC123' });
 * // => "https://meet.example.com/?room=ABC123"
 *
 * // Pre-filled name, auto-joins
 * const link = generateJoinLink({ room: 'ABC123', name: 'John Doe' });
 * // => "https://meet.example.com/?room=ABC123&name=John%20Doe&autojoin=true"
 *
 * // Pre-filled name, but don't auto-join
 * const link = generateJoinLink({ room: 'ABC123', name: 'John', autojoin: false });
 * // => "https://meet.example.com/?room=ABC123&name=John&autojoin=false"
 *
 * // With quality preset
 * const link = generateJoinLink({ room: 'ABC123', name: 'John', quality: 'max' });
 * // => "https://meet.example.com/?room=ABC123&name=John&autojoin=true&quality=max"
 * ```
 */
export function generateJoinLink(options: JoinLinkOptions): string {
  const { room, name, autojoin, quality } = options;

  const params = new URLSearchParams();
  params.set('room', parseRoomCode(room));

  if (name) {
    params.set('name', name);
    // Default autojoin to true when name is provided
    params.set('autojoin', autojoin !== false ? 'true' : 'false');
  } else if (autojoin !== undefined) {
    params.set('autojoin', autojoin ? 'true' : 'false');
  }

  if (quality) {
    params.set('quality', quality);
  }

  const baseUrl = window.location.origin + window.location.pathname;
  return `${baseUrl}?${params.toString()}`;
}

/**
 * Generate a simple join link with just the room code
 *
 * @param roomCode - The room code
 * @returns Join link URL
 *
 * @example
 * ```typescript
 * const link = getJoinLink('ABC123');
 * // => "https://meet.example.com/?room=ABC123"
 * ```
 */
export function getJoinLink(roomCode: string): string {
  return generateJoinLink({ room: roomCode });
}

/**
 * Clear join link parameters from the URL without page reload
 *
 * Call this after processing join link parameters to clean up the URL.
 */
export function clearJoinLinkParams(): void {
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState({}, '', url.toString());
}

/**
 * Check if the current URL has join link parameters
 *
 * @returns true if URL contains room parameter
 */
export function hasJoinLinkParams(): boolean {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.has('room') || urlParams.has('name');
}

/**
 * End meeting for all participants (host only)
 */
export async function endMeetingForAll(roomName: string, participantIdentity: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/end-meeting`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      roomName,
      participantIdentity,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to end meeting' }));
    throw new Error(error.error || 'Failed to end meeting');
  }
}

// ============================================================================
// ADMIN API
// ============================================================================

/**
 * Get the API base URL for admin endpoints
 */
export function getApiBaseUrl(): string {
  return API_URL;
}

/**
 * Get the OpenAPI documentation URL
 */
export function getOpenApiUrl(): string {
  return `${API_URL}/api/openapi.yaml`;
}

export interface AdminLoginResponse {
  success: boolean;
  token: string;
  expiresAt: string;
  isFirstLogin?: boolean;
  superAdmin?: string;
}

/**
 * Admin login
 */
export async function adminLogin(password: string): Promise<AdminLoginResponse> {
  const response = await fetch(`${API_URL}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(error.error || 'Login failed');
  }

  return response.json();
}

/**
 * Admin logout
 */
export async function adminLogout(token: string): Promise<void> {
  await fetch(`${API_URL}/api/admin/logout`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
}

export interface ServerStats {
  activeRooms: number;
  totalParticipants: number;
  apiKeysCount: number;
  webhooksCount: number;
  uptime: number;
  version: string;
}

/**
 * Get server statistics
 */
export async function getServerStats(token: string): Promise<ServerStats> {
  const response = await fetch(`${API_URL}/api/admin/stats`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to get stats' }));
    throw new Error(error.error || 'Failed to get stats');
  }

  return response.json();
}

export interface RoomInfo {
  name: string;
  displayName: string | null;
  numParticipants: number;
  createdAt: string | null;
  maxParticipants: number;
}

/**
 * List active rooms
 */
export async function listRooms(token: string): Promise<{ rooms: RoomInfo[]; total: number }> {
  const response = await fetch(`${API_URL}/api/rooms`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list rooms' }));
    throw new Error(error.error || 'Failed to list rooms');
  }

  return response.json();
}

/**
 * Update room display name
 */
export async function updateRoomDisplayName(
  token: string,
  roomName: string,
  displayName: string
): Promise<RoomInfo> {
  const response = await fetch(`${API_URL}/api/rooms/${roomName}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ displayName }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to update room' }));
    throw new Error(error.error || 'Failed to update room');
  }

  return response.json();
}

// API Key types and functions
export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreateApiKeyResponse {
  id: string;
  name: string;
  key: string;
  permissions: string[];
  createdAt: string;
}

/**
 * List API keys
 */
export async function listApiKeys(token: string): Promise<{ apiKeys: ApiKeyInfo[] }> {
  const response = await fetch(`${API_URL}/api/admin/api-keys`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list API keys' }));
    throw new Error(error.error || 'Failed to list API keys');
  }

  return response.json();
}

/**
 * Create API key
 */
export async function createApiKey(
  token: string,
  name: string,
  permissions: string[] = ['read']
): Promise<CreateApiKeyResponse> {
  const response = await fetch(`${API_URL}/api/admin/api-keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ name, permissions }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to create API key' }));
    throw new Error(error.error || 'Failed to create API key');
  }

  return response.json();
}

/**
 * Revoke API key
 */
export async function revokeApiKey(token: string, keyId: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/admin/api-keys/${keyId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to revoke API key' }));
    throw new Error(error.error || 'Failed to revoke API key');
  }
}

// Webhook types and functions
export interface WebhookInfo {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret: string;
  createdAt: string;
  lastTriggeredAt: string | null;
  failureCount: number;
}

export interface CreateWebhookResponse extends WebhookInfo {
  secret: string; // Full secret only on creation
}

export const WEBHOOK_EVENTS = [
  'room.created',
  'room.deleted',
  'participant.joined',
  'participant.left',
  'recording.started',
  'recording.stopped',
] as const;

export type WebhookEventType = typeof WEBHOOK_EVENTS[number];

/**
 * List webhooks
 */
export async function listWebhooks(token: string): Promise<{ webhooks: WebhookInfo[] }> {
  const response = await fetch(`${API_URL}/api/admin/webhooks`, {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to list webhooks' }));
    throw new Error(error.error || 'Failed to list webhooks');
  }

  return response.json();
}

/**
 * Create webhook
 */
export async function createWebhook(
  token: string,
  name: string,
  url: string,
  events: string[],
  enabled: boolean = true
): Promise<CreateWebhookResponse> {
  const response = await fetch(`${API_URL}/api/admin/webhooks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ name, url, events, enabled }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to create webhook' }));
    throw new Error(error.error || 'Failed to create webhook');
  }

  return response.json();
}

/**
 * Update webhook
 */
export async function updateWebhook(
  token: string,
  webhookId: string,
  updates: Partial<{ name: string; url: string; events: string[]; enabled: boolean }>
): Promise<WebhookInfo> {
  const response = await fetch(`${API_URL}/api/admin/webhooks/${webhookId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to update webhook' }));
    throw new Error(error.error || 'Failed to update webhook');
  }

  return response.json();
}

/**
 * Delete webhook
 */
export async function deleteWebhook(token: string, webhookId: string): Promise<void> {
  const response = await fetch(`${API_URL}/api/admin/webhooks/${webhookId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to delete webhook' }));
    throw new Error(error.error || 'Failed to delete webhook');
  }
}

export interface WebhookTestResult {
  success: boolean;
  statusCode: number;
  responseTime: number;
  error: string | null;
}

/**
 * Test webhook
 */
export async function testWebhook(token: string, webhookId: string): Promise<WebhookTestResult> {
  const response = await fetch(`${API_URL}/api/admin/webhooks/${webhookId}/test`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to test webhook' }));
    throw new Error(error.error || 'Failed to test webhook');
  }

  return response.json();
}

