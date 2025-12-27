# MEET Style Guide

This document outlines the coding standards, conventions, and best practices for contributing to the MEET video conferencing platform.

## Table of Contents

- [General Principles](#general-principles)
- [TypeScript Conventions](#typescript-conventions)
- [React Patterns](#react-patterns)
- [State Management](#state-management)
- [Styling with Tailwind CSS](#styling-with-tailwind-css)
- [API & Backend Conventions](#api--backend-conventions)
- [File & Folder Organization](#file--folder-organization)
- [Naming Conventions](#naming-conventions)
- [Error Handling](#error-handling)
- [Git Conventions](#git-conventions)
- [Documentation](#documentation)

---

## General Principles

### Code Quality

- **Simplicity over complexity**: Write clear, readable code. Avoid over-engineering.
- **DRY (Don't Repeat Yourself)**: Extract reusable logic into utilities, hooks, or components.
- **Single Responsibility**: Each function, component, or module should do one thing well.
- **Type Safety**: Leverage TypeScript's type system fully. Avoid `any` types.

### Consistency

- Follow existing patterns in the codebase
- Use the project's ESLint and TypeScript configurations
- Maintain consistent formatting across all files

---

## TypeScript Conventions

### Strict Mode

Both frontend and API use TypeScript strict mode. All code must compile without errors.

```typescript
// tsconfig.json essentials
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

### Type Definitions

#### Interface Definitions

Use interfaces for object shapes and type aliases for unions/primitives:

```typescript
// Interfaces for object shapes
interface TokenRequest {
  roomName: string;
  participantName: string;
  deviceId?: string;
}

// Type aliases for unions or primitives
type VideoQuality = 'auto' | 'high' | 'max' | 'balanced' | 'low';
type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
```

#### Explicit Return Types

Always declare explicit return types for functions:

```typescript
// Good
function generateRoomCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function fetchToken(request: TokenRequest): Promise<TokenResponse> {
  // ...
}

// Avoid
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
```

#### Optional Properties

Use optional chaining and nullish coalescing:

```typescript
// Good
const displayName = participant?.name ?? 'Anonymous';
const videoEnabled = settings?.video?.enabled ?? true;

// Avoid
const displayName = participant && participant.name ? participant.name : 'Anonymous';
```

### Import Organization

Organize imports in the following order, separated by blank lines:

```typescript
// 1. React and core libraries
import { useState, useEffect, useCallback } from 'react';

// 2. Third-party libraries
import { Room, RoomEvent, Participant } from 'livekit-client';
import toast from 'react-hot-toast';

// 3. Internal modules (stores, hooks, utilities)
import { useRoomStore } from '../stores/roomStore';
import { useLiveKit } from '../hooks/useLiveKit';

// 4. Components
import { VideoTile } from './VideoTile';
import { ControlBar } from './ControlBar';

// 5. Types (if separate)
import type { RoomMetadata, ParticipantInfo } from '../types';
```

---

## React Patterns

### Component Structure

Use functional components with hooks. Follow this structure:

```typescript
import { useState, useEffect, useCallback } from 'react';

interface VideoTileProps {
  participant: Participant;
  isLocal: boolean;
  showOverlay?: boolean;
}

export function VideoTile({ participant, isLocal, showOverlay = true }: VideoTileProps): JSX.Element {
  // 1. Hooks (state, refs, context)
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  // 2. Derived state / computed values
  const displayName = participant.name || 'Anonymous';
  const hasVideo = participant.videoTrackPublications.size > 0;

  // 3. Effects
  useEffect(() => {
    // Effect logic
  }, [participant]);

  // 4. Event handlers
  const handleVideoToggle = useCallback(() => {
    setIsVideoEnabled(prev => !prev);
  }, []);

  // 5. Render helpers (if needed)
  const renderOverlay = () => {
    if (!showOverlay) return null;
    return <div className="participant-overlay">{displayName}</div>;
  };

  // 6. Main render
  return (
    <div className="video-tile">
      <video ref={videoRef} autoPlay playsInline muted={isLocal} />
      {renderOverlay()}
    </div>
  );
}
```

### Custom Hooks

Extract reusable logic into custom hooks prefixed with `use`:

```typescript
// hooks/useMediaDevices.ts
export function useMediaDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>('');
  const [selectedMicrophone, setSelectedMicrophone] = useState<string>('');

  useEffect(() => {
    // Enumerate devices
  }, []);

  const refreshDevices = useCallback(async () => {
    // Refresh logic
  }, []);

  return {
    devices,
    selectedCamera,
    selectedMicrophone,
    setSelectedCamera,
    setSelectedMicrophone,
    refreshDevices,
  };
}
```

### Event Handlers

Prefix event handlers with `handle`:

```typescript
// Good
const handleClick = () => { /* ... */ };
const handleSubmit = (e: FormEvent) => { /* ... */ };
const handleRoomConnect = (room: Room) => { /* ... */ };

// Avoid
const clickHandler = () => { /* ... */ };
const onClickButton = () => { /* ... */ };
```

### Conditional Rendering

Use early returns for cleaner conditional rendering:

```typescript
// Good
function VideoRoom({ room }: VideoRoomProps): JSX.Element {
  if (!room) {
    return <div className="loading">Connecting...</div>;
  }

  if (room.state === 'disconnected') {
    return <div className="error">Connection lost</div>;
  }

  return (
    <div className="video-room">
      {/* Main content */}
    </div>
  );
}

// Avoid deeply nested ternaries
function VideoRoom({ room }: VideoRoomProps): JSX.Element {
  return room ? (
    room.state !== 'disconnected' ? (
      <div className="video-room">{/* ... */}</div>
    ) : (
      <div className="error">Connection lost</div>
    )
  ) : (
    <div className="loading">Connecting...</div>
  );
}
```

### Props Destructuring

Destructure props in the function signature with default values:

```typescript
// Good
function ControlBar({
  isMuted = false,
  isVideoOff = false,
  isScreenSharing = false,
  onToggleMute,
  onToggleVideo,
  onToggleScreenShare,
  onLeave,
}: ControlBarProps): JSX.Element {
  // ...
}

// Avoid
function ControlBar(props: ControlBarProps): JSX.Element {
  const isMuted = props.isMuted ?? false;
  // ...
}
```

---

## State Management

### Zustand Store Pattern

Use Zustand for global state management. Structure stores as follows:

```typescript
// stores/roomStore.ts
import { create } from 'zustand';

interface RoomState {
  // State
  roomName: string;
  participantName: string;
  isConnected: boolean;
  participants: Map<string, ParticipantInfo>;

  // Actions
  setRoomName: (name: string) => void;
  setParticipantName: (name: string) => void;
  setConnected: (connected: boolean) => void;
  addParticipant: (id: string, info: ParticipantInfo) => void;
  removeParticipant: (id: string) => void;
  reset: () => void;
}

const initialState = {
  roomName: '',
  participantName: '',
  isConnected: false,
  participants: new Map(),
};

export const useRoomStore = create<RoomState>((set) => ({
  ...initialState,

  setRoomName: (name) => set({ roomName: name }),
  setParticipantName: (name) => set({ participantName: name }),
  setConnected: (connected) => set({ isConnected: connected }),

  addParticipant: (id, info) =>
    set((state) => ({
      participants: new Map(state.participants).set(id, info),
    })),

  removeParticipant: (id) =>
    set((state) => {
      const participants = new Map(state.participants);
      participants.delete(id);
      return { participants };
    }),

  reset: () => set(initialState),
}));
```

### Store Usage in Components

Use selective subscriptions to prevent unnecessary re-renders:

```typescript
// Good - selective subscription
function VideoRoom(): JSX.Element {
  const roomName = useRoomStore((state) => state.roomName);
  const isConnected = useRoomStore((state) => state.isConnected);
  // ...
}

// Avoid - subscribing to entire store
function VideoRoom(): JSX.Element {
  const store = useRoomStore();
  // This re-renders on ANY store change
}
```

### Local vs Global State

- **Global state (Zustand)**: Room info, participant data, connection status, settings
- **Local state (useState)**: UI state, form inputs, component-specific toggles

```typescript
// Global - affects multiple components
const isConnected = useRoomStore((state) => state.isConnected);

// Local - only affects this component
const [isDropdownOpen, setIsDropdownOpen] = useState(false);
```

---

## Styling with Tailwind CSS

### Class Organization

Order Tailwind classes logically:

```typescript
// Order: layout → sizing → spacing → typography → colors → effects → states
<div className="flex items-center justify-between w-full h-16 px-4 py-2 text-sm font-medium text-white bg-meet-bg-secondary rounded-lg shadow-lg hover:bg-meet-bg-tertiary transition-colors">
```

### Custom Theme Colors

Use the project's custom color palette defined in `tailwind.config.js`:

```typescript
// Background colors
'bg-meet-bg'           // Primary background (#0a0a0f)
'bg-meet-bg-secondary' // Secondary background (#12121a)
'bg-meet-bg-tertiary'  // Tertiary background (#1a1a24)

// Accent colors
'text-meet-accent'     // Cyan accent (#00d4ff)
'border-meet-accent'   // Cyan border

// Status colors
'text-meet-success'    // Green (#10b981)
'text-meet-warning'    // Yellow (#f59e0b)
'text-meet-error'      // Red (#ef4444)

// Glass effects
'bg-meet-glass'        // Semi-transparent overlay
```

### Component Styling Patterns

```typescript
// Button variants
const buttonBase = "px-4 py-2 rounded-lg font-medium transition-colors focus:outline-none focus:ring-2";
const buttonPrimary = `${buttonBase} bg-meet-accent text-black hover:bg-meet-accent/90 focus:ring-meet-accent/50`;
const buttonSecondary = `${buttonBase} bg-meet-bg-tertiary text-white hover:bg-meet-bg-secondary focus:ring-white/20`;
const buttonDanger = `${buttonBase} bg-meet-error text-white hover:bg-meet-error/90 focus:ring-meet-error/50`;

// Card/container pattern
const card = "bg-meet-bg-secondary rounded-xl p-6 shadow-lg border border-white/5";

// Input pattern
const input = "w-full px-4 py-3 bg-meet-bg-tertiary border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-meet-accent focus:ring-1 focus:ring-meet-accent";
```

### Responsive Design

Use mobile-first responsive classes:

```typescript
// Mobile-first approach
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {/* Cards */}
</div>

// Responsive text
<h1 className="text-xl md:text-2xl lg:text-3xl font-bold">
  Meeting Room
</h1>
```

### Avoiding Inline Styles

Prefer Tailwind classes over inline styles:

```typescript
// Good
<div className="w-64 h-48 opacity-75">

// Avoid
<div style={{ width: '256px', height: '192px', opacity: 0.75 }}>
```

---

## API & Backend Conventions

### Express Route Structure

Organize routes with clear middleware chains:

```typescript
// Route pattern: verb + path + middlewares + handler
app.get('/api/rooms', authenticateAdmin, async (req, res) => {
  try {
    const rooms = await roomService.listRooms();
    res.json({ rooms });
  } catch (error) {
    console.error('Failed to list rooms:', error);
    res.status(500).json({ error: 'Failed to list rooms' });
  }
});

// Group related routes
// Admin routes
app.post('/api/admin/login', handleAdminLogin);
app.post('/api/admin/logout', authenticateAdmin, handleAdminLogout);
app.get('/api/admin/stats', authenticateAdmin, handleGetStats);

// Room routes
app.get('/api/rooms', authenticateAdmin, handleListRooms);
app.post('/api/rooms', authenticateApiKeyOrAdmin, handleCreateRoom);
app.delete('/api/rooms/:roomName', authenticateAdmin, handleDeleteRoom);
```

### Response Format

Use consistent JSON response structures:

```typescript
// Success response
res.json({
  success: true,
  data: { /* ... */ }
});

// or simply return the data
res.json({ rooms, totalCount });

// Error response
res.status(400).json({
  error: 'Validation failed',
  message: 'Room name is required'
});

// List response with pagination
res.json({
  items: [...],
  total: 100,
  page: 1,
  pageSize: 20
});
```

### Error Handling

Use try-catch with appropriate status codes:

```typescript
app.post('/api/token', async (req, res) => {
  try {
    const { roomName, participantName } = req.body;

    // Validation
    if (!roomName || !participantName) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'roomName and participantName are required'
      });
    }

    // Business logic
    const token = await generateToken(roomName, participantName);
    res.json({ token });

  } catch (error) {
    console.error('Token generation failed:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to generate token'
    });
  }
});
```

### Authentication Middleware

Follow the established authentication pattern:

```typescript
function authenticateAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.substring(7);
  const session = sessions.get(token);

  if (!session || session.expiresAt < Date.now()) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.adminSession = session;
  next();
}
```

---

## File & Folder Organization

### Frontend Structure

```
frontend/src/
├── components/          # React components
│   ├── JoinForm.tsx     # Entry/join form
│   ├── VideoRoom.tsx    # Main video room
│   ├── VideoTile.tsx    # Individual video tile
│   ├── ControlBar.tsx   # Meeting controls
│   ├── AdminPanel.tsx   # Admin dashboard
│   └── ConfirmModal.tsx # Reusable modal
├── hooks/               # Custom React hooks
│   ├── useLiveKit.ts    # LiveKit connection management
│   └── useMediaDevices.ts
├── stores/              # Zustand state stores
│   ├── roomStore.ts     # Room/participant state
│   └── adminStore.ts    # Admin panel state
├── lib/                 # Utilities and API functions
│   └── livekit.ts       # API calls, helpers
├── types/               # TypeScript type definitions (if needed)
├── App.tsx              # Root component
├── main.tsx             # Entry point
└── index.css            # Global styles
```

### API Structure

```
api/src/
├── index.ts             # Main server file
├── routes/              # Route handlers (future expansion)
├── middleware/          # Express middleware (future expansion)
├── services/            # Business logic (future expansion)
└── types/               # TypeScript types (future expansion)
```

### File Naming

| Type | Convention | Example |
|------|------------|---------|
| React Components | PascalCase | `VideoRoom.tsx`, `ControlBar.tsx` |
| Hooks | camelCase with `use` prefix | `useLiveKit.ts`, `useMediaDevices.ts` |
| Stores | camelCase with `Store` suffix | `roomStore.ts`, `adminStore.ts` |
| Utilities | camelCase | `livekit.ts`, `helpers.ts` |
| Types | camelCase or PascalCase | `types.ts`, `RoomTypes.ts` |
| Config files | lowercase with dots | `vite.config.ts`, `tailwind.config.js` |

---

## Naming Conventions

### Variables and Functions

```typescript
// Variables: camelCase
const roomName = 'meeting-123';
const participantCount = 5;
const isVideoEnabled = true;

// Functions: camelCase, verb-first for actions
function createRoom(name: string): Room { }
function handleSubmit(event: FormEvent): void { }
function generateToken(roomName: string): string { }

// Boolean variables: is/has/can/should prefix
const isLoading = true;
const hasPermission = false;
const canJoin = true;
const shouldAutoConnect = false;
```

### Constants

```typescript
// Environment variables and config: UPPER_SNAKE_CASE
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const MAX_PARTICIPANTS = 50;
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

// Arrays of constants
const WEBHOOK_EVENTS = [
  'room_started',
  'room_finished',
  'participant_joined',
  'participant_left',
] as const;

const VIDEO_QUALITY_PRESETS = {
  auto: { width: 1280, height: 720 },
  high: { width: 1920, height: 1080 },
  low: { width: 640, height: 480 },
} as const;
```

### React Components and Props

```typescript
// Components: PascalCase
function VideoRoom(): JSX.Element { }
function ParticipantOverlay(): JSX.Element { }

// Props interfaces: ComponentName + Props
interface VideoRoomProps {
  roomName: string;
  onLeave: () => void;
}

interface ControlBarProps {
  isMuted: boolean;
  onToggleMute: () => void;
}
```

### Event Handlers

```typescript
// Component event handlers: handle + Event
const handleClick = () => { };
const handleSubmit = (e: FormEvent) => { };
const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => { };

// Callback props: on + Action
interface Props {
  onClick: () => void;
  onSubmit: (data: FormData) => void;
  onRoomJoin: (room: Room) => void;
}
```

---

## Error Handling

### Frontend Error Handling

Use toast notifications for user-facing errors:

```typescript
import toast from 'react-hot-toast';

async function joinRoom(roomName: string): Promise<void> {
  try {
    const token = await fetchToken(roomName, participantName);
    await room.connect(livekitUrl, token);
    toast.success('Connected to room');
  } catch (error) {
    console.error('Failed to join room:', error);
    toast.error('Failed to join room. Please try again.');
  }
}
```

### Error Boundaries (for critical sections)

```typescript
// Wrap critical UI sections
<ErrorBoundary fallback={<ErrorFallback />}>
  <VideoRoom />
</ErrorBoundary>
```

### API Error Responses

Return consistent error structures:

```typescript
// Validation errors (400)
res.status(400).json({
  error: 'Validation failed',
  message: 'Room name must be at least 3 characters'
});

// Authentication errors (401)
res.status(401).json({
  error: 'Authentication required',
  message: 'Please provide a valid access token'
});

// Authorization errors (403)
res.status(403).json({
  error: 'Access denied',
  message: 'You do not have permission to perform this action'
});

// Not found errors (404)
res.status(404).json({
  error: 'Not found',
  message: 'Room not found'
});

// Server errors (500)
res.status(500).json({
  error: 'Internal server error',
  message: 'An unexpected error occurred'
});
```

### Logging

Use descriptive log messages:

```typescript
// Good
console.error('Failed to create room:', { roomName, error: error.message });
console.log('Participant joined:', { participantId, roomName });

// Avoid
console.log('error');
console.log(error);
```

---

## Git Conventions

### Branch Naming

```
feature/add-screen-sharing
fix/video-reconnection-issue
refactor/simplify-room-store
docs/update-api-documentation
chore/upgrade-dependencies
```

### Commit Messages

Follow conventional commits format:

```
<type>(<scope>): <description>

[optional body]
[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**

```
feat(video): add picture-in-picture self view

fix(api): handle token generation for empty room names

refactor(stores): simplify room store state management

docs: update API documentation with new endpoints

chore: upgrade livekit-client to v2.1.0
```

### Pull Request Guidelines

1. **Title**: Use conventional commit format
2. **Description**: Include:
   - What changes were made
   - Why the changes were needed
   - How to test the changes
3. **Size**: Keep PRs focused and reasonably sized
4. **Tests**: Include tests for new functionality
5. **Documentation**: Update relevant documentation

---

## Documentation

### Code Comments

Use comments sparingly and only when the code isn't self-explanatory:

```typescript
// Good - explains "why"
// Using a Map instead of Object for O(1) participant lookups
const participants = new Map<string, ParticipantInfo>();

// Good - explains complex logic
// LiveKit sends participant updates before the participant object
// is fully initialized, so we need to defer processing
setTimeout(() => processParticipant(participant), 0);

// Avoid - states the obvious
// Set the room name
setRoomName(name);

// Avoid - redundant with type system
// Returns a string
function getRoomCode(): string { }
```

### JSDoc for Public APIs

Document public functions and complex utilities:

```typescript
/**
 * Generates a LiveKit access token for a participant
 * @param roomName - The name of the room to join
 * @param participantName - Display name for the participant
 * @param options - Additional token options
 * @returns JWT access token string
 * @throws Error if LiveKit credentials are not configured
 */
async function generateToken(
  roomName: string,
  participantName: string,
  options?: TokenOptions
): Promise<string> {
  // ...
}
```

### README Updates

When adding new features:
1. Update relevant documentation
2. Add configuration examples if needed
3. Update API documentation for new endpoints

---

## Quick Reference

### Do's

- Use TypeScript strict mode
- Write functional components with hooks
- Use Zustand for global state
- Use Tailwind CSS utility classes
- Follow consistent naming conventions
- Handle errors gracefully with user feedback
- Write descriptive commit messages

### Don'ts

- Avoid `any` types
- Don't use class components
- Don't use inline styles
- Don't ignore TypeScript errors
- Don't commit console.log statements (use proper logging)
- Don't leave commented-out code

---

## Resources

- [React Documentation](https://react.dev)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [Zustand Documentation](https://github.com/pmndrs/zustand)
- [LiveKit Documentation](https://docs.livekit.io)
- [Conventional Commits](https://www.conventionalcommits.org)
