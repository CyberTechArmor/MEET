import { Room, RoomOptions, VideoPresets } from 'livekit-client';

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
}

/**
 * Save session for auto-rejoin on refresh
 */
export function saveSession(roomCode: string, displayName: string): void {
  const session: SessionData = {
    roomCode,
    displayName,
    timestamp: Date.now(),
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
 */
export function createRoom(): Room {
  const roomOptions: RoomOptions = {
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: {
      resolution: VideoPresets.h720.resolution,
    },
    publishDefaults: {
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
    },
  };

  return new Room(roomOptions);
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
