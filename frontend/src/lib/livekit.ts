import { Room, RoomOptions, VideoPresets } from 'livekit-client';

// API configuration - dynamically determine URLs based on current hostname
function getApiUrl(): string {
  // If explicitly set via env var, use that
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  // Otherwise, derive from current location
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
  // If explicitly set via env var, use that
  if (import.meta.env.VITE_LIVEKIT_URL) {
    return import.meta.env.VITE_LIVEKIT_URL;
  }

  // Otherwise, derive from current location
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostname = window.location.hostname;

  // LiveKit runs on port 7880
  return `${wsProtocol}//${hostname}:7880`;
}

const API_URL = getApiUrl();
const LIVEKIT_URL = getLiveKitWsUrl();

export interface TokenResponse {
  token: string;
  roomName: string;
  participantName: string;
}

export interface RoomCodeResponse {
  roomCode: string;
}

/**
 * Fetch a token for joining a LiveKit room
 */
export async function getToken(roomName: string, participantName: string): Promise<TokenResponse> {
  const response = await fetch(`${API_URL}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ roomName, participantName }),
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
