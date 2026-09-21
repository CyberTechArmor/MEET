import { create } from 'zustand';
import type { Room, LocalParticipant, RemoteParticipant, ConnectionState } from 'livekit-client';

export type AppView = 'join' | 'room';

interface RoomState {
  // View state
  view: AppView;
  setView: (view: AppView) => void;

  // User info
  displayName: string;
  setDisplayName: (name: string) => void;
  roomCode: string;
  setRoomCode: (code: string) => void;

  // Room state
  room: Room | null;
  setRoom: (room: Room | null) => void;
  connectionState: ConnectionState;
  setConnectionState: (state: ConnectionState) => void;

  // Participants
  localParticipant: LocalParticipant | null;
  setLocalParticipant: (participant: LocalParticipant | null) => void;
  remoteParticipants: RemoteParticipant[];
  setRemoteParticipants: (participants: RemoteParticipant[]) => void;
  addRemoteParticipant: (participant: RemoteParticipant) => void;
  removeRemoteParticipant: (identity: string) => void;

  // Media state
  isMicEnabled: boolean;
  setMicEnabled: (enabled: boolean) => void;
  isCameraEnabled: boolean;
  setCameraEnabled: (enabled: boolean) => void;
  isScreenSharing: boolean;
  setScreenSharing: (sharing: boolean) => void;

  // Screen share tracking - identity of the participant whose share should be displayed
  activeScreenShareIdentity: string | null;
  setActiveScreenShareIdentity: (identity: string | null) => void;

  // Host state
  isHost: boolean;
  setIsHost: (isHost: boolean) => void;

  // UI state
  controlsVisible: boolean;
  setControlsVisible: (visible: boolean) => void;
  controlsPinned: boolean;
  setControlsPinned: (pinned: boolean) => void;

  // Embed mode
  hideEndCall: boolean;
  setHideEndCall: (hide: boolean) => void;
  // Set once from the join link (`embed=1` or iframe). Deliberately NOT
  // part of initialState so reset() after leaving a call keeps the SPA in
  // embed mode with the same room, instead of dropping the host page into
  // the full create/join configuration screen.
  embedMode: boolean;
  embedRoomCode: string;
  setEmbed: (embedMode: boolean, embedRoomCode: string) => void;
  // Embed mode joins on its own unless the link says autojoin=false.
  embedAutoJoin: boolean;
  setEmbedAutoJoin: (v: boolean) => void;
  // True while App.tsx is (re)connecting automatically — JoinForm shows a
  // spinner instead of the name prompt.
  embedJoining: boolean;
  setEmbedJoining: (v: boolean) => void;
  // Why the last room connection ended (livekit DisconnectReason numeric
  // value), or null if never / cleared. Not part of initialState so it
  // survives reset() and App.tsx can decide whether to rejoin.
  lastDisconnectReason: number | null;
  setLastDisconnectReason: (r: number | null) => void;
  // Host-controlled layout override via the embed messaging API:
  // 'auto' follows the window size, 'on'/'off' force compact mode.
  compactOverride: 'auto' | 'on' | 'off';
  setCompactOverride: (v: 'auto' | 'on' | 'off') => void;
  // MEET's own Document Picture-in-Picture window is open.
  pipOpen: boolean;
  setPipOpen: (v: boolean) => void;

  // Reset state
  reset: () => void;
  resetKeepingName: () => void;
}

const initialState = {
  view: 'join' as AppView,
  displayName: '',
  roomCode: '',
  room: null,
  connectionState: 'disconnected' as ConnectionState,
  localParticipant: null,
  remoteParticipants: [],
  isMicEnabled: true,
  isCameraEnabled: true,
  isScreenSharing: false,
  isHost: false,
  controlsVisible: true,
  controlsPinned: false,
  activeScreenShareIdentity: null,
  hideEndCall: false,
};

export const useRoomStore = create<RoomState>((set) => ({
  ...initialState,

  setView: (view) => set({ view }),

  setDisplayName: (displayName) => set({ displayName }),
  setRoomCode: (roomCode) => set({ roomCode }),

  setRoom: (room) => set({ room }),
  setConnectionState: (connectionState) => set({ connectionState }),

  setLocalParticipant: (localParticipant) => set({ localParticipant }),
  setRemoteParticipants: (remoteParticipants) => set({ remoteParticipants }),
  addRemoteParticipant: (participant) =>
    set((state) => ({
      remoteParticipants: [...state.remoteParticipants.filter(p => p.identity !== participant.identity), participant],
    })),
  removeRemoteParticipant: (identity) =>
    set((state) => ({
      remoteParticipants: state.remoteParticipants.filter((p) => p.identity !== identity),
    })),

  setMicEnabled: (isMicEnabled) => set({ isMicEnabled }),
  setCameraEnabled: (isCameraEnabled) => set({ isCameraEnabled }),
  setScreenSharing: (isScreenSharing) => set({ isScreenSharing }),

  setActiveScreenShareIdentity: (activeScreenShareIdentity) => set({ activeScreenShareIdentity }),

  setIsHost: (isHost) => set({ isHost }),

  setControlsVisible: (controlsVisible) => set({ controlsVisible }),
  setControlsPinned: (controlsPinned) => set({ controlsPinned }),

  setHideEndCall: (hideEndCall) => set({ hideEndCall }),

  embedMode: false,
  embedRoomCode: '',
  setEmbed: (embedMode, embedRoomCode) => set({ embedMode, embedRoomCode }),
  embedAutoJoin: true,
  setEmbedAutoJoin: (embedAutoJoin) => set({ embedAutoJoin }),
  embedJoining: false,
  setEmbedJoining: (embedJoining) => set({ embedJoining }),
  lastDisconnectReason: null,
  setLastDisconnectReason: (lastDisconnectReason) => set({ lastDisconnectReason }),
  compactOverride: 'auto',
  setCompactOverride: (compactOverride) => set({ compactOverride }),
  pipOpen: false,
  setPipOpen: (pipOpen) => set({ pipOpen }),

  reset: () => set(initialState),
  resetKeepingName: () => set((state) => ({ ...initialState, displayName: state.displayName })),
}));
