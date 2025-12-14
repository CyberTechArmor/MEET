import express, { Request, Response } from 'express';
import cors from 'cors';
import { AccessToken } from 'livekit-server-sdk';

const app = express();

// Configuration
const PORT = process.env.PORT || 8080;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

// Middleware
app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true,
}));
app.use(express.json());

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Token generation endpoint
interface TokenRequest {
  roomName: string;
  participantName: string;
}

app.post('/api/token', async (req: Request<{}, {}, TokenRequest>, res: Response) => {
  try {
    const { roomName, participantName } = req.body;

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

    // Create access token
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: sanitizedParticipantName,
      name: sanitizedParticipantName,
    });

    // Grant permissions for the room
    token.addGrant({
      room: sanitizedRoomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    // Generate JWT token
    const jwt = await token.toJwt();

    res.json({
      token: jwt,
      roomName: sanitizedRoomName,
      participantName: sanitizedParticipantName,
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
