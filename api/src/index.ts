import express, { Request, Response } from 'express';
import cors from 'cors';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const app = express();

// Configuration
const PORT = process.env.PORT || 8080;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'http://localhost:7880';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Initialize RoomServiceClient for room management
const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// CORS configuration - supports '*' for all origins or comma-separated list
const corsOptions: cors.CorsOptions = {
  origin: CORS_ORIGIN === '*'
    ? true  // Allow all origins
    : CORS_ORIGIN.includes(',')
      ? CORS_ORIGIN.split(',').map(o => o.trim())  // Multiple origins
      : CORS_ORIGIN,  // Single origin
  credentials: CORS_ORIGIN !== '*',  // Only send credentials for specific origins
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Token generation endpoint
interface TokenRequest {
  roomName: string;
  participantName: string;
  deviceId?: string;
}

app.post('/api/token', async (req: Request<{}, {}, TokenRequest>, res: Response) => {
  try {
    const { roomName, participantName, deviceId } = req.body;

    // Validate input
    if (!roomName || typeof roomName !== 'string') {
      res.status(400).json({ error: 'roomName is required' });
      return;
    }

    if (!participantName || typeof participantName !== 'string') {
      res.status(400).json({ error: 'participantName is required' });
      return;
    }

    // Sanitize room name (alphanumeric, hyphens, underscores only)
    const sanitizedRoomName = roomName.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 50);
    const sanitizedParticipantName = participantName.slice(0, 50);

    if (!sanitizedRoomName) {
      res.status(400).json({ error: 'Invalid room name' });
      return;
    }

    // Generate unique identity using deviceId if provided
    // This allows multiple people with the same display name to join
    // and allows the same user on multiple devices
    const sanitizedDeviceId = deviceId ? deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) : '';
    const participantIdentity = sanitizedDeviceId
      ? `${sanitizedParticipantName}_${sanitizedDeviceId}`
      : `${sanitizedParticipantName}_${Date.now()}`;

    // Check if room exists to determine if this user is the host
    let isHost = false;
    try {
      const rooms = await roomService.listRooms([sanitizedRoomName]);
      // If room doesn't exist or has no participants, this user is the host
      isHost = rooms.length === 0 || (rooms[0]?.numParticipants ?? 0) === 0;
    } catch (err) {
      // If we can't check, assume they're the host if room doesn't exist
      console.warn('Could not check room status:', err);
      isHost = true;
    }

    // Create access token
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: sanitizedParticipantName, // Display name shown to others
    });

    // Grant permissions for the room
    // Host gets room admin permission to end the meeting
    token.addGrant({
      room: sanitizedRoomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: isHost, // Host can administrate the room
    });

    // Generate JWT token
    const jwt = await token.toJwt();

    res.json({
      token: jwt,
      roomName: sanitizedRoomName,
      participantName: sanitizedParticipantName,
      participantIdentity: participantIdentity,
      isHost: isHost,
    });

  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Generate random room code
app.get('/api/room-code', (_req: Request, res: Response) => {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  res.json({ roomCode: code });
});

// End meeting for all participants (host only)
interface EndMeetingRequest {
  roomName: string;
  participantIdentity: string;
}

app.post('/api/end-meeting', async (req: Request<{}, {}, EndMeetingRequest>, res: Response) => {
  try {
    const { roomName, participantIdentity } = req.body;

    if (!roomName || typeof roomName !== 'string') {
      res.status(400).json({ error: 'roomName is required' });
      return;
    }

    if (!participantIdentity || typeof participantIdentity !== 'string') {
      res.status(400).json({ error: 'participantIdentity is required' });
      return;
    }

    const sanitizedRoomName = roomName.replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 50);

    // Delete the room - this will disconnect all participants
    await roomService.deleteRoom(sanitizedRoomName);

    console.log(`Room ${sanitizedRoomName} ended by ${participantIdentity}`);

    res.json({ success: true, message: 'Meeting ended for all participants' });

  } catch (error) {
    console.error('End meeting error:', error);
    res.status(500).json({ error: 'Failed to end meeting' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║          MEET API Server                       ║
╠════════════════════════════════════════════════╣
║  Port:      ${String(PORT).padEnd(35)}║
║  CORS:      ${CORS_ORIGIN.padEnd(35)}║
║  LiveKit:   Ready                              ║
╚════════════════════════════════════════════════╝
  `);
});
