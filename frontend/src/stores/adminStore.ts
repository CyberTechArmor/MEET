import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Types
export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Webhook {
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

export interface ServerStats {
  activeRooms: number;
  totalParticipants: number;
  apiKeysCount: number;
  webhooksCount: number;
  uptime: number;
  version: string;
}

export interface RoomInfo {
  name: string;
  displayName: string | null;
  numParticipants: number;
  createdAt: string | null;
  maxParticipants: number;
}

interface AdminState {
  // Auth state
  isAuthenticated: boolean;
  token: string | null;
  expiresAt: string | null;
  isFirstLogin: boolean;

  // Data
  stats: ServerStats | null;
  apiKeys: ApiKey[];
  webhooks: Webhook[];
  rooms: RoomInfo[];

  // Loading states
  isLoading: boolean;
  error: string | null;

  // Actions
  setAuth: (token: string, expiresAt: string, isFirstLogin?: boolean) => void;
  logout: () => void;
  setStats: (stats: ServerStats) => void;
  setApiKeys: (keys: ApiKey[]) => void;
  setWebhooks: (webhooks: Webhook[]) => void;
  setRooms: (rooms: RoomInfo[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Check if session is valid
  isSessionValid: () => boolean;
}

const initialState = {
  isAuthenticated: false,
  token: null,
  expiresAt: null,
  isFirstLogin: false,
  stats: null,
  apiKeys: [],
  webhooks: [],
  rooms: [],
  isLoading: false,
  error: null,
};

export const useAdminStore = create<AdminState>()(
  persist(
    (set, get) => ({
      ...initialState,

      setAuth: (token, expiresAt, isFirstLogin = false) =>
        set({
          isAuthenticated: true,
          token,
          expiresAt,
          isFirstLogin,
          error: null,
        }),

      logout: () =>
        set({
          ...initialState,
        }),

      setStats: (stats) => set({ stats }),
      setApiKeys: (apiKeys) => set({ apiKeys }),
      setWebhooks: (webhooks) => set({ webhooks }),
      setRooms: (rooms) => set({ rooms }),
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error }),

      isSessionValid: () => {
        const state = get();
        if (!state.token || !state.expiresAt) return false;
        return new Date(state.expiresAt) > new Date();
      },
    }),
    {
      name: 'meet-admin-store',
      partialize: (state) => ({
        token: state.token,
        expiresAt: state.expiresAt,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
