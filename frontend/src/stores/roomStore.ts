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

  // Host state
  isHost: boolean;
  setIsHost: (isHost: boolean) => void;

  // UI state
  controlsVisible: boolean;
  setControlsVisible: (visible: boolean) => void;

  // Reset state
  reset: () => void;
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

  setIsHost: (isHost) => set({ isHost }),

  setControlsVisible: (controlsVisible) => set({ controlsVisible }),

  reset: () => set(initialState),
}));
