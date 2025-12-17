import { useState, useEffect, useCallback, useRef } from 'react';
import { useAdminStore } from '../stores/adminStore';
import {
  adminLogin,
  adminLogout,
  getServerStats,
  listRooms,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  getOpenApiUrl,
  getAdminWebSocketUrl,
  getJoinLink,
  formatRoomCode,
  updateRoomDisplayName,
  getServerSettings,
  updateServerSettings,
  WEBHOOK_EVENTS,
} from '../lib/livekit';
import type { ApiKeyInfo, WebhookInfo, CreateApiKeyResponse, CreateWebhookResponse, ServerSettings } from '../lib/livekit';
import type { RoomInfo } from '../stores/adminStore';

type TabType = 'dashboard' | 'settings' | 'api-keys' | 'webhooks' | 'docs';
type DocsSubTab = 'api' | 'iframe';

interface AdminPanelProps {
  onClose: () => void;
}

// WebSocket connection state
type WsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'polling';

function AdminPanel({ onClose }: AdminPanelProps) {
  const {
    isAuthenticated,
    token,
    isSessionValid,
    setAuth,
    logout,
    stats,
    setStats,
    apiKeys,
    setApiKeys,
    webhooks,
    setWebhooks,
    rooms,
    setRooms,
    isLoading,
    setLoading,
    error,
    setError,
  } = useAdminStore();

  const [activeTab, setActiveTab] = useState<TabType>('dashboard');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const [wsState, setWsState] = useState<WsConnectionState>('disconnected');
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRetriesRef = useRef(0);
  const maxWsRetries = 3;

  // API Key creation state
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyPermissions, setNewKeyPermissions] = useState<string[]>(['read']);
  const [createdKey, setCreatedKey] = useState<CreateApiKeyResponse | null>(null);

  // Webhook creation state
  const [showWebhookForm, setShowWebhookForm] = useState(false);
  const [webhookForm, setWebhookForm] = useState({
    name: '',
    url: '',
    events: [] as string[],
    enabled: true,
  });
  const [createdWebhook, setCreatedWebhook] = useState<CreateWebhookResponse | null>(null);
  const [testingWebhook, setTestingWebhook] = useState<string | null>(null);

  // Copy feedback state
  const [copiedRoom, setCopiedRoom] = useState<string | null>(null);

  // Room display name editing state
  const [editingRoom, setEditingRoom] = useState<string | null>(null);
  const [editingDisplayName, setEditingDisplayName] = useState('');

  // Settings state
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [settingsRecommendations, setSettingsRecommendations] = useState<{
    maxParticipantsPerMeeting: number;
    maxConcurrentMeetings: number;
  } | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [newIframeDomain, setNewIframeDomain] = useState('');

  // Docs sub-tab state
  const [docsSubTab, setDocsSubTab] = useState<DocsSubTab>('api');

  // Check session validity on mount
  useEffect(() => {
    if (isAuthenticated && !isSessionValid()) {
      logout();
    }
  }, [isAuthenticated, isSessionValid, logout]);

  // Initial data loaded flag
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);

  // Load data via REST API (primary method for initial load)
  const loadData = useCallback(async (showLoading = true) => {
    if (!token) return;

    if (showLoading) {
      setLoading(true);
    }
    setError(null);

    try {
      const [statsData, roomsData, keysData, webhooksData] = await Promise.all([
        getServerStats(token),
        listRooms(token),
        listApiKeys(token),
        listWebhooks(token),
      ]);

      setStats(statsData);
      setRooms(roomsData.rooms);
      setApiKeys(keysData.apiKeys);
      setWebhooks(webhooksData.webhooks);
      setInitialDataLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [token, setStats, setRooms, setApiKeys, setWebhooks, setLoading, setError]);

  // Start polling as fallback for real-time updates
  const startPolling = useCallback(() => {
    if (pollingIntervalRef.current) return; // Already polling

    console.log('Starting REST API polling for real-time updates');
    setWsState('polling');
    pollingIntervalRef.current = setInterval(() => {
      if (token) {
        loadData(false); // Load data without showing loading spinner
      }
    }, 5000); // Poll every 5 seconds
  }, [token, loadData]);

  // Stop polling
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  // WebSocket connection for real-time updates only (not initial load)
  const connectWebSocket = useCallback(() => {
    if (!token || wsRef.current?.readyState === WebSocket.OPEN) return;

    // Check if we've exceeded max retries
    if (wsRetriesRef.current >= maxWsRetries) {
      console.log('Max WebSocket retries exceeded, falling back to polling');
      startPolling();
      return;
    }

    setWsState('connecting');
    const wsUrl = getAdminWebSocketUrl();

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected, authenticating...');
        wsRetriesRef.current = 0; // Reset retry counter on successful connection
        stopPolling(); // Stop polling if WebSocket connects
        // Send auth message
        ws.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === 'auth_required') {
            // Server is ready for auth
            ws.send(JSON.stringify({ type: 'auth', token }));
          } else if (message.type === 'init') {
            // WebSocket authenticated, just mark as connected
            // Initial data already loaded via REST API
            setWsState('connected');
            wsRetriesRef.current = 0;
          } else if (message.type === 'update') {
            // Real-time update from server - update data
            const { data } = message;
            if (data.stats) setStats(data.stats);
            if (data.rooms) setRooms(data.rooms);
            if (data.apiKeys) setApiKeys(data.apiKeys);
            if (data.webhooks) setWebhooks(data.webhooks);
          } else if (message.type === 'error') {
            console.error('WebSocket error:', message.error);
            // Don't set error state for WebSocket issues - REST API is primary
          }
        } catch (err) {
          console.error('WebSocket message parse error:', err);
        }
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setWsState('disconnected');
        wsRef.current = null;
        wsRetriesRef.current++;

        // If exceeded retries, start polling
        if (wsRetriesRef.current >= maxWsRetries) {
          console.log('WebSocket failed, switching to polling');
          startPolling();
          return;
        }

        // Attempt to reconnect after delay
        if (token) {
          const delay = Math.min(5000 * wsRetriesRef.current, 15000); // Exponential backoff up to 15s
          reconnectTimeoutRef.current = setTimeout(() => {
            connectWebSocket();
          }, delay);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        // onclose will be called after this
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      wsRetriesRef.current++;
      if (wsRetriesRef.current >= maxWsRetries) {
        startPolling();
      }
    }
  }, [token, setStats, setRooms, setApiKeys, setWebhooks, startPolling, stopPolling]);

  // Load initial data via REST API when authenticated
  useEffect(() => {
    if (isAuthenticated && token && !initialDataLoaded) {
      loadData(true);
    }
  }, [isAuthenticated, token, initialDataLoaded, loadData]);

  // Connect WebSocket for real-time updates after initial data is loaded
  useEffect(() => {
    if (isAuthenticated && token && initialDataLoaded) {
      wsRetriesRef.current = 0; // Reset retries when starting fresh
      connectWebSocket();
    }

    return () => {
      // Cleanup WebSocket and polling on unmount
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [isAuthenticated, token, initialDataLoaded, connectWebSocket]);

  // Request refresh via WebSocket
  const requestRefresh = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'refresh' }));
    } else {
      // Fallback to REST API
      loadData(true);
    }
  }, [loadData]);

  // Handle login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');

    try {
      const response = await adminLogin(username, password);
      setAuth(response.token, response.expiresAt, response.isFirstLogin);
      setUsername('');
      setPassword('');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  // Handle logout
  const handleLogout = async () => {
    // Close WebSocket connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    wsRetriesRef.current = 0;
    if (token) {
      await adminLogout(token);
    }
    setInitialDataLoaded(false);
    logout();
  };

  // Handle API key creation
  const handleCreateApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !newKeyName) return;

    try {
      const key = await createApiKey(token, newKeyName, newKeyPermissions);
      setCreatedKey(key);
      setNewKeyName('');
      setNewKeyPermissions(['read']);
      requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    }
  };

  // Handle API key revocation
  const handleRevokeApiKey = async (keyId: string) => {
    if (!token) return;

    try {
      await revokeApiKey(token, keyId);
      requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke API key');
    }
  };

  // Handle webhook creation
  const handleCreateWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !webhookForm.name || !webhookForm.url || webhookForm.events.length === 0) return;

    try {
      const webhook = await createWebhook(
        token,
        webhookForm.name,
        webhookForm.url,
        webhookForm.events,
        webhookForm.enabled
      );
      setCreatedWebhook(webhook);
      setWebhookForm({ name: '', url: '', events: [], enabled: true });
      setShowWebhookForm(false);
      requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create webhook');
    }
  };

  // Handle webhook toggle
  const handleToggleWebhook = async (webhook: WebhookInfo) => {
    if (!token) return;

    try {
      await updateWebhook(token, webhook.id, { enabled: !webhook.enabled });
      requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update webhook');
    }
  };

  // Handle webhook deletion
  const handleDeleteWebhook = async (webhookId: string) => {
    if (!token) return;

    try {
      await deleteWebhook(token, webhookId);
      requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete webhook');
    }
  };

  // Handle webhook test
  const handleTestWebhook = async (webhookId: string) => {
    if (!token) return;

    setTestingWebhook(webhookId);
    try {
      const result = await testWebhook(token, webhookId);
      alert(
        result.success
          ? `Webhook test successful! Response time: ${result.responseTime}ms`
          : `Webhook test failed: ${result.error}`
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to test webhook');
    } finally {
      setTestingWebhook(null);
    }
  };

  // Handle copy join link
  const handleCopyJoinLink = async (room: RoomInfo) => {
    const link = getJoinLink(room.name);
    await navigator.clipboard.writeText(link);
    setCopiedRoom(room.name);
    setTimeout(() => setCopiedRoom(null), 2000);
  };

  // Handle edit display name
  const handleStartEditDisplayName = (room: RoomInfo) => {
    setEditingRoom(room.name);
    setEditingDisplayName(room.displayName || '');
  };

  // Handle save display name
  const handleSaveDisplayName = async (roomName: string) => {
    if (!token) return;

    try {
      await updateRoomDisplayName(token, roomName, editingDisplayName);
      setEditingRoom(null);
      setEditingDisplayName('');
      requestRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update display name');
    }
  };

  // Handle cancel edit
  const handleCancelEdit = () => {
    setEditingRoom(null);
    setEditingDisplayName('');
  };

  // Load settings
  const loadSettings = useCallback(async () => {
    if (!token) return;
    setSettingsLoading(true);
    try {
      const response = await getServerSettings(token);
      setSettings(response.settings);
      setSettingsRecommendations(response.recommendations);
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setSettingsLoading(false);
    }
  }, [token]);

  // Load settings when tab changes to settings
  useEffect(() => {
    if (activeTab === 'settings' && !settings && !settingsLoading) {
      loadSettings();
    }
  }, [activeTab, settings, settingsLoading, loadSettings]);

  // Handle settings update
  const handleUpdateSettings = async (updates: Partial<ServerSettings>) => {
    if (!token) return;
    setSettingsSaving(true);
    try {
      const response = await updateServerSettings(token, updates);
      setSettings(response.settings);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update settings');
    } finally {
      setSettingsSaving(false);
    }
  };

  // Format uptime
  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  // Login screen
  if (!isAuthenticated) {
    return (
      <div className="fixed inset-0 bg-meet-bg/95 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div className="glass rounded-2xl p-8 w-full max-w-md shadow-soft">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-meet-text-primary">Admin Login</h2>
            <button
              onClick={onClose}
              className="text-meet-text-secondary hover:text-meet-text-primary transition-smooth"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <p className="text-meet-text-secondary mb-6 text-sm">
            Enter your admin credentials to access the admin panel. If this is your first login, the credentials you enter will be set as the admin account.
          </p>

          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
              autoFocus
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
            />

            {loginError && (
              <div className="bg-meet-error/10 border border-meet-error/30 rounded-lg px-4 py-2 text-meet-error text-sm">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-semibold py-3 px-6 rounded-xl transition-smooth"
            >
              Login
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Admin panel
  return (
    <div className="fixed inset-0 bg-meet-bg/95 backdrop-blur-sm z-50 flex flex-col">
      {/* Header */}
      <div className="glass border-b border-meet-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold text-meet-text-primary">Admin Panel</h1>
            {stats && (
              <span className="text-xs text-meet-text-tertiary">v{stats.version}</span>
            )}
            <span className={`text-xs flex items-center gap-1 ${
              wsState === 'connected' ? 'text-meet-success' :
              wsState === 'polling' ? 'text-blue-400' :
              wsState === 'connecting' ? 'text-yellow-500' :
              'text-meet-error'
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                wsState === 'connected' ? 'bg-meet-success animate-pulse' :
                wsState === 'polling' ? 'bg-blue-400 animate-pulse' :
                wsState === 'connecting' ? 'bg-yellow-500 animate-pulse' :
                'bg-meet-error'
              }`}></span>
              {wsState === 'connected' ? 'Live' :
               wsState === 'polling' ? 'Polling' :
               wsState === 'connecting' ? 'Connecting...' : 'Disconnected'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={requestRefresh}
              className="text-meet-text-secondary hover:text-meet-text-primary transition-smooth text-sm flex items-center gap-1"
              title="Refresh"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
            <button
              onClick={handleLogout}
              className="text-meet-text-secondary hover:text-meet-text-primary transition-smooth text-sm"
            >
              Logout
            </button>
            <button
              onClick={onClose}
              className="text-meet-text-secondary hover:text-meet-text-primary transition-smooth"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-4">
          {(['dashboard', 'settings', 'api-keys', 'webhooks', 'docs'] as TabType[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-smooth ${
                activeTab === tab
                  ? 'bg-meet-accent text-meet-bg'
                  : 'text-meet-text-secondary hover:text-meet-text-primary hover:bg-meet-bg-tertiary'
              }`}
            >
              {tab === 'api-keys' ? 'API Keys' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="bg-meet-error/10 border border-meet-error/30 rounded-lg px-4 py-2 text-meet-error text-sm mb-4">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin h-8 w-8 border-4 border-meet-accent border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <>
            {/* Dashboard Tab */}
            {activeTab === 'dashboard' && stats && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="glass rounded-xl p-4">
                    <div className="text-meet-text-tertiary text-sm">Active Rooms</div>
                    <div className="text-3xl font-bold text-meet-text-primary">{stats.activeRooms}</div>
                  </div>
                  <div className="glass rounded-xl p-4">
                    <div className="text-meet-text-tertiary text-sm">Total Participants</div>
                    <div className="text-3xl font-bold text-meet-text-primary">{stats.totalParticipants}</div>
                  </div>
                  <div className="glass rounded-xl p-4">
                    <div className="text-meet-text-tertiary text-sm">API Keys</div>
                    <div className="text-3xl font-bold text-meet-text-primary">{stats.apiKeysCount}</div>
                  </div>
                  <div className="glass rounded-xl p-4">
                    <div className="text-meet-text-tertiary text-sm">Uptime</div>
                    <div className="text-3xl font-bold text-meet-text-primary">{formatUptime(stats.uptime)}</div>
                  </div>
                </div>

                {/* Active Rooms List */}
                <div className="glass rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-meet-text-primary mb-4">Active Rooms</h3>
                  {rooms.length === 0 ? (
                    <p className="text-meet-text-tertiary">No active rooms</p>
                  ) : (
                    <div className="space-y-3">
                      {rooms.map((room) => (
                        <div
                          key={room.name}
                          className="bg-meet-bg-tertiary rounded-lg px-4 py-3"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                              <span className="font-mono text-meet-text-primary text-lg">
                                {formatRoomCode(room.name)}
                              </span>
                              {editingRoom === room.name ? (
                                <div className="flex items-center gap-2">
                                  <input
                                    type="text"
                                    value={editingDisplayName}
                                    onChange={(e) => setEditingDisplayName(e.target.value)}
                                    placeholder="Meeting name (optional)"
                                    className="bg-meet-bg border border-meet-border rounded-lg px-3 py-1 text-sm text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') handleSaveDisplayName(room.name);
                                      if (e.key === 'Escape') handleCancelEdit();
                                    }}
                                  />
                                  <button
                                    onClick={() => handleSaveDisplayName(room.name)}
                                    className="text-meet-success hover:text-meet-success/80 p-1"
                                    title="Save"
                                  >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={handleCancelEdit}
                                    className="text-meet-text-tertiary hover:text-meet-text-secondary p-1"
                                    title="Cancel"
                                  >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                  </button>
                                </div>
                              ) : (
                                <>
                                  {room.displayName ? (
                                    <span className="text-meet-text-secondary text-sm">
                                      "{room.displayName}"
                                    </span>
                                  ) : (
                                    <button
                                      onClick={() => handleStartEditDisplayName(room)}
                                      className="text-meet-text-tertiary hover:text-meet-accent text-xs flex items-center gap-1 transition-smooth"
                                    >
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                      </svg>
                                      Add name
                                    </button>
                                  )}
                                  {room.displayName && (
                                    <button
                                      onClick={() => handleStartEditDisplayName(room)}
                                      className="text-meet-text-tertiary hover:text-meet-text-secondary p-1 transition-smooth"
                                      title="Edit name"
                                    >
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                      </svg>
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                            <span className="text-sm text-meet-text-secondary">
                              {room.numParticipants} participant{room.numParticipants !== 1 ? 's' : ''}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleCopyJoinLink(room)}
                              className={`flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg transition-smooth ${
                                copiedRoom === room.name
                                  ? 'bg-meet-success/20 text-meet-success'
                                  : 'bg-meet-accent/20 text-meet-accent hover:bg-meet-accent/30'
                              }`}
                            >
                              {copiedRoom === room.name ? (
                                <>
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                  Copied!
                                </>
                              ) : (
                                <>
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                  </svg>
                                  Copy Join Link
                                </>
                              )}
                            </button>
                            <a
                              href={getJoinLink(room.name)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-meet-bg hover:bg-meet-bg-elevated text-meet-text-secondary hover:text-meet-text-primary transition-smooth"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                              Join
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Settings Tab */}
            {activeTab === 'settings' && (
              <div className="space-y-6">
                {settingsLoading ? (
                  <div className="flex items-center justify-center h-64">
                    <div className="animate-spin h-8 w-8 border-4 border-meet-accent border-t-transparent rounded-full"></div>
                  </div>
                ) : settings ? (
                  <>
                    {/* Public Access */}
                    <div className="glass rounded-xl p-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-lg font-semibold text-meet-text-primary">Public Access</h3>
                          <p className="text-sm text-meet-text-tertiary mt-1">
                            When disabled, only API requests with valid API keys can create/join meetings. The public web interface will show an error.
                          </p>
                        </div>
                        <button
                          onClick={() => handleUpdateSettings({ publicAccessEnabled: !settings.publicAccessEnabled })}
                          disabled={settingsSaving}
                          className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors ${
                            settings.publicAccessEnabled ? 'bg-meet-success' : 'bg-meet-bg-tertiary'
                          } ${settingsSaving ? 'opacity-50' : ''}`}
                        >
                          <span
                            className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                              settings.publicAccessEnabled ? 'translate-x-8' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </div>
                      <div className={`mt-2 text-sm font-medium ${settings.publicAccessEnabled ? 'text-meet-success' : 'text-meet-error'}`}>
                        {settings.publicAccessEnabled ? 'Enabled - Anyone can use the public interface' : 'Disabled - API access only'}
                      </div>
                    </div>

                    {/* Participants Per Meeting */}
                    <div className="glass rounded-xl p-6">
                      <h3 className="text-lg font-semibold text-meet-text-primary">Participants per Meeting</h3>
                      <p className="text-sm text-meet-text-tertiary mt-1 mb-4">
                        Maximum number of participants allowed in a single meeting.
                        {settingsRecommendations && (
                          <span className="text-meet-accent ml-1">
                            Recommended: {settingsRecommendations.maxParticipantsPerMeeting} based on server resources
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-4">
                        <select
                          value={settings.maxParticipantsPerMeeting === 0 ? 'unlimited' : 'custom'}
                          onChange={(e) => {
                            if (e.target.value === 'unlimited') {
                              handleUpdateSettings({ maxParticipantsPerMeeting: 0 });
                            } else if (e.target.value === 'recommended' && settingsRecommendations) {
                              handleUpdateSettings({ maxParticipantsPerMeeting: settingsRecommendations.maxParticipantsPerMeeting });
                            }
                          }}
                          disabled={settingsSaving}
                          className="bg-meet-bg-tertiary border border-meet-border rounded-lg px-4 py-2 text-meet-text-primary focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
                        >
                          <option value="unlimited">Unlimited</option>
                          <option value="recommended">Recommended ({settingsRecommendations?.maxParticipantsPerMeeting})</option>
                          <option value="custom">Custom</option>
                        </select>
                        {settings.maxParticipantsPerMeeting > 0 && (
                          <input
                            type="number"
                            value={settings.maxParticipantsPerMeeting}
                            onChange={(e) => {
                              const value = parseInt(e.target.value) || 0;
                              if (value >= 0) {
                                handleUpdateSettings({ maxParticipantsPerMeeting: value });
                              }
                            }}
                            min="1"
                            max="1000"
                            disabled={settingsSaving}
                            className="w-24 bg-meet-bg-tertiary border border-meet-border rounded-lg px-4 py-2 text-meet-text-primary focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
                          />
                        )}
                      </div>
                      <div className="mt-2 text-sm text-meet-text-secondary">
                        Current: {settings.maxParticipantsPerMeeting === 0 ? 'Unlimited' : `${settings.maxParticipantsPerMeeting} participants`}
                      </div>
                    </div>

                    {/* Concurrent Meetings */}
                    <div className="glass rounded-xl p-6">
                      <h3 className="text-lg font-semibold text-meet-text-primary">Concurrent Meetings</h3>
                      <p className="text-sm text-meet-text-tertiary mt-1 mb-4">
                        Maximum number of active meetings at the same time.
                        {settingsRecommendations && (
                          <span className="text-meet-accent ml-1">
                            Recommended: {settingsRecommendations.maxConcurrentMeetings} based on server resources
                          </span>
                        )}
                      </p>
                      <div className="flex items-center gap-4">
                        <select
                          value={settings.maxConcurrentMeetings === 0 ? 'unlimited' : 'custom'}
                          onChange={(e) => {
                            if (e.target.value === 'unlimited') {
                              handleUpdateSettings({ maxConcurrentMeetings: 0 });
                            } else if (e.target.value === 'recommended' && settingsRecommendations) {
                              handleUpdateSettings({ maxConcurrentMeetings: settingsRecommendations.maxConcurrentMeetings });
                            }
                          }}
                          disabled={settingsSaving}
                          className="bg-meet-bg-tertiary border border-meet-border rounded-lg px-4 py-2 text-meet-text-primary focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
                        >
                          <option value="unlimited">Unlimited</option>
                          <option value="recommended">Recommended ({settingsRecommendations?.maxConcurrentMeetings})</option>
                          <option value="custom">Custom</option>
                        </select>
                        {settings.maxConcurrentMeetings > 0 && (
                          <input
                            type="number"
                            value={settings.maxConcurrentMeetings}
                            onChange={(e) => {
                              const value = parseInt(e.target.value) || 0;
                              if (value >= 0) {
                                handleUpdateSettings({ maxConcurrentMeetings: value });
                              }
                            }}
                            min="1"
                            max="100"
                            disabled={settingsSaving}
                            className="w-24 bg-meet-bg-tertiary border border-meet-border rounded-lg px-4 py-2 text-meet-text-primary focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
                          />
                        )}
                      </div>
                      <div className="mt-2 text-sm text-meet-text-secondary">
                        Current: {settings.maxConcurrentMeetings === 0 ? 'Unlimited' : `${settings.maxConcurrentMeetings} concurrent meetings`}
                      </div>
                    </div>

                    {/* Iframe Embedding Domains */}
                    <div className="glass rounded-xl p-6">
                      <h3 className="text-lg font-semibold text-meet-text-primary">Iframe Embedding Domains</h3>
                      <p className="text-sm text-meet-text-tertiary mt-1 mb-4">
                        Control which domains can embed MEET in an iframe. Leave empty to allow all domains (*).
                      </p>

                      {/* Add domain input */}
                      <div className="flex gap-2 mb-4">
                        <input
                          type="text"
                          placeholder="e.g., https://example.com or *.example.com"
                          value={newIframeDomain}
                          onChange={(e) => setNewIframeDomain(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && newIframeDomain.trim()) {
                              e.preventDefault();
                              const domain = newIframeDomain.trim();
                              if (!settings.iframeAllowedDomains.includes(domain)) {
                                handleUpdateSettings({
                                  iframeAllowedDomains: [...settings.iframeAllowedDomains, domain]
                                });
                              }
                              setNewIframeDomain('');
                            }
                          }}
                          disabled={settingsSaving}
                          className="flex-1 bg-meet-bg-tertiary border border-meet-border rounded-lg px-4 py-2 text-meet-text-primary placeholder-meet-text-tertiary focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
                        />
                        <button
                          onClick={() => {
                            const domain = newIframeDomain.trim();
                            if (domain && !settings.iframeAllowedDomains.includes(domain)) {
                              handleUpdateSettings({
                                iframeAllowedDomains: [...settings.iframeAllowedDomains, domain]
                              });
                            }
                            setNewIframeDomain('');
                          }}
                          disabled={settingsSaving || !newIframeDomain.trim()}
                          className="px-4 py-2 bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-medium rounded-lg transition-smooth disabled:opacity-50"
                        >
                          Add
                        </button>
                      </div>

                      {/* Current status */}
                      <div className={`mb-4 text-sm font-medium ${settings.iframeAllowedDomains.length === 0 ? 'text-meet-warning' : 'text-meet-success'}`}>
                        {settings.iframeAllowedDomains.length === 0
                          ? 'Currently allowing all domains (*)'
                          : `Restricting to ${settings.iframeAllowedDomains.length} domain(s)`}
                      </div>

                      {/* Domain list */}
                      {settings.iframeAllowedDomains.length > 0 && (
                        <div className="space-y-2">
                          {settings.iframeAllowedDomains.map((domain, index) => (
                            <div
                              key={index}
                              className="flex items-center justify-between bg-meet-bg-tertiary rounded-lg px-4 py-2"
                            >
                              <code className="text-meet-text-primary">{domain}</code>
                              <button
                                onClick={() => {
                                  handleUpdateSettings({
                                    iframeAllowedDomains: settings.iframeAllowedDomains.filter((_, i) => i !== index)
                                  });
                                }}
                                disabled={settingsSaving}
                                className="text-meet-error hover:text-red-400 transition-smooth disabled:opacity-50"
                                title="Remove domain"
                              >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Info box */}
                      <div className="mt-4 p-3 bg-meet-bg-secondary rounded-lg">
                        <p className="text-xs text-meet-text-tertiary">
                          <strong className="text-meet-text-secondary">Examples:</strong><br />
                          • <code className="text-meet-accent">https://chat.example.com</code> - Specific domain<br />
                          • <code className="text-meet-accent">*.example.com</code> - All subdomains<br />
                          • <code className="text-meet-accent">https://*.neoncore.io</code> - All HTTPS subdomains
                        </p>
                      </div>
                    </div>

                    {/* Settings Info */}
                    <div className="glass rounded-xl p-6 bg-meet-accent/5 border border-meet-accent/20">
                      <h3 className="text-lg font-semibold text-meet-accent mb-2">About Settings</h3>
                      <ul className="text-sm text-meet-text-secondary space-y-2">
                        <li>• Settings take effect immediately for new connections</li>
                        <li>• Existing meetings are not affected by changes</li>
                        <li>• API access is always allowed regardless of Public Access setting</li>
                        <li>• Set to 0 for unlimited (not recommended for production)</li>
                        <li>• Iframe domains control the CSP frame-ancestors header</li>
                      </ul>
                    </div>
                  </>
                ) : (
                  <div className="text-center text-meet-text-tertiary py-8">
                    Failed to load settings. <button onClick={loadSettings} className="text-meet-accent hover:underline">Try again</button>
                  </div>
                )}
              </div>
            )}

            {/* API Keys Tab */}
            {activeTab === 'api-keys' && (
              <div className="space-y-6">
                {/* Create API Key Form */}
                <div className="glass rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-meet-text-primary mb-4">Create API Key</h3>
                  <form onSubmit={handleCreateApiKey} className="space-y-4">
                    <input
                      type="text"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      placeholder="API key name (e.g., 'Production Integration')"
                      className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
                    />
                    <div className="flex flex-wrap gap-2">
                      {['read', 'write', 'admin'].map((perm) => (
                        <label key={perm} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={newKeyPermissions.includes(perm)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setNewKeyPermissions([...newKeyPermissions, perm]);
                              } else {
                                setNewKeyPermissions(newKeyPermissions.filter((p) => p !== perm));
                              }
                            }}
                            className="rounded border-meet-border text-meet-accent focus:ring-meet-accent"
                          />
                          <span className="text-sm text-meet-text-secondary capitalize">{perm}</span>
                        </label>
                      ))}
                    </div>
                    <button
                      type="submit"
                      disabled={!newKeyName}
                      className="bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-semibold py-2 px-4 rounded-lg transition-smooth disabled:opacity-50"
                    >
                      Create API Key
                    </button>
                  </form>

                  {/* Show created key */}
                  {createdKey && (
                    <div className="mt-4 p-4 bg-meet-success/10 border border-meet-success/30 rounded-lg">
                      <p className="text-meet-success text-sm mb-2">API key created! Copy it now - it won't be shown again.</p>
                      <code className="block bg-meet-bg-tertiary p-3 rounded text-sm text-meet-text-primary font-mono break-all">
                        {createdKey.key}
                      </code>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(createdKey.key);
                          setCreatedKey(null);
                        }}
                        className="mt-2 text-sm text-meet-accent hover:underline"
                      >
                        Copy and dismiss
                      </button>
                    </div>
                  )}
                </div>

                {/* API Keys List */}
                <div className="glass rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-meet-text-primary mb-4">API Keys</h3>
                  {apiKeys.length === 0 ? (
                    <p className="text-meet-text-tertiary">No API keys created yet</p>
                  ) : (
                    <div className="space-y-2">
                      {apiKeys.map((key: ApiKeyInfo) => (
                        <div
                          key={key.id}
                          className="flex items-center justify-between bg-meet-bg-tertiary rounded-lg px-4 py-3"
                        >
                          <div>
                            <div className="font-medium text-meet-text-primary">{key.name}</div>
                            <div className="text-sm text-meet-text-tertiary font-mono">{key.keyPrefix}</div>
                            <div className="flex gap-2 mt-1">
                              {key.permissions.map((perm) => (
                                <span
                                  key={perm}
                                  className="text-xs bg-meet-bg px-2 py-0.5 rounded text-meet-text-secondary"
                                >
                                  {perm}
                                </span>
                              ))}
                            </div>
                          </div>
                          <button
                            onClick={() => handleRevokeApiKey(key.id)}
                            className="text-meet-error hover:text-meet-error/80 text-sm"
                          >
                            Revoke
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Webhooks Tab */}
            {activeTab === 'webhooks' && (
              <div className="space-y-6">
                {/* Create Webhook Button */}
                {!showWebhookForm && (
                  <button
                    onClick={() => setShowWebhookForm(true)}
                    className="bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-semibold py-2 px-4 rounded-lg transition-smooth"
                  >
                    Create Webhook
                  </button>
                )}

                {/* Show created webhook secret */}
                {createdWebhook && (
                  <div className="glass rounded-xl p-4 bg-meet-success/10 border border-meet-success/30">
                    <p className="text-meet-success text-sm mb-2">Webhook created! Copy the secret - it won't be shown again.</p>
                    <code className="block bg-meet-bg-tertiary p-3 rounded text-sm text-meet-text-primary font-mono break-all">
                      {createdWebhook.secret}
                    </code>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(createdWebhook.secret);
                        setCreatedWebhook(null);
                      }}
                      className="mt-2 text-sm text-meet-accent hover:underline"
                    >
                      Copy and dismiss
                    </button>
                  </div>
                )}

                {/* Create Webhook Form */}
                {showWebhookForm && (
                  <div className="glass rounded-xl p-6">
                    <h3 className="text-lg font-semibold text-meet-text-primary mb-4">Create Webhook</h3>
                    <form onSubmit={handleCreateWebhook} className="space-y-4">
                      <input
                        type="text"
                        value={webhookForm.name}
                        onChange={(e) => setWebhookForm({ ...webhookForm, name: e.target.value })}
                        placeholder="Webhook name"
                        className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
                      />
                      <input
                        type="url"
                        value={webhookForm.url}
                        onChange={(e) => setWebhookForm({ ...webhookForm, url: e.target.value })}
                        placeholder="Webhook URL (https://...)"
                        className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
                      />
                      <div>
                        <div className="text-sm text-meet-text-secondary mb-2">Events:</div>
                        <div className="flex flex-wrap gap-2">
                          {WEBHOOK_EVENTS.map((event) => (
                            <label key={event} className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={webhookForm.events.includes(event)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setWebhookForm({ ...webhookForm, events: [...webhookForm.events, event] });
                                  } else {
                                    setWebhookForm({
                                      ...webhookForm,
                                      events: webhookForm.events.filter((ev) => ev !== event),
                                    });
                                  }
                                }}
                                className="rounded border-meet-border text-meet-accent focus:ring-meet-accent"
                              />
                              <span className="text-sm text-meet-text-secondary">{event}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={!webhookForm.name || !webhookForm.url || webhookForm.events.length === 0}
                          className="bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-semibold py-2 px-4 rounded-lg transition-smooth disabled:opacity-50"
                        >
                          Create
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowWebhookForm(false)}
                          className="bg-meet-bg-tertiary hover:bg-meet-bg-elevated text-meet-text-primary font-medium py-2 px-4 rounded-lg transition-smooth"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Webhooks List */}
                <div className="glass rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-meet-text-primary mb-4">Webhooks</h3>
                  {webhooks.length === 0 ? (
                    <p className="text-meet-text-tertiary">No webhooks configured</p>
                  ) : (
                    <div className="space-y-3">
                      {webhooks.map((webhook: WebhookInfo) => (
                        <div
                          key={webhook.id}
                          className="bg-meet-bg-tertiary rounded-lg px-4 py-3"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                              <span className="font-medium text-meet-text-primary">{webhook.name}</span>
                              <span
                                className={`text-xs px-2 py-0.5 rounded ${
                                  webhook.enabled
                                    ? 'bg-meet-success/20 text-meet-success'
                                    : 'bg-meet-error/20 text-meet-error'
                                }`}
                              >
                                {webhook.enabled ? 'Active' : 'Disabled'}
                              </span>
                              {webhook.failureCount > 0 && (
                                <span className="text-xs text-meet-error">
                                  {webhook.failureCount} failures
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleTestWebhook(webhook.id)}
                                disabled={testingWebhook === webhook.id}
                                className="text-sm text-meet-accent hover:text-meet-accent-light disabled:opacity-50"
                              >
                                {testingWebhook === webhook.id ? 'Testing...' : 'Test'}
                              </button>
                              <button
                                onClick={() => handleToggleWebhook(webhook)}
                                className="text-sm text-meet-text-secondary hover:text-meet-text-primary"
                              >
                                {webhook.enabled ? 'Disable' : 'Enable'}
                              </button>
                              <button
                                onClick={() => handleDeleteWebhook(webhook.id)}
                                className="text-sm text-meet-error hover:text-meet-error/80"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                          <div className="text-sm text-meet-text-tertiary font-mono break-all">
                            {webhook.url}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-2">
                            {webhook.events.map((event) => (
                              <span
                                key={event}
                                className="text-xs bg-meet-bg px-2 py-0.5 rounded text-meet-text-secondary"
                              >
                                {event}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Docs Tab - API and Iframe Integration */}
            {activeTab === 'docs' && (
              <div className="space-y-6">
                {/* Sub-tabs */}
                <div className="glass rounded-xl p-1 inline-flex gap-1">
                  <button
                    onClick={() => setDocsSubTab('api')}
                    className={`px-6 py-2.5 rounded-lg text-sm font-medium transition-smooth ${
                      docsSubTab === 'api'
                        ? 'bg-meet-accent text-meet-bg'
                        : 'text-meet-text-secondary hover:text-meet-text-primary hover:bg-meet-bg-tertiary'
                    }`}
                  >
                    API Reference
                  </button>
                  <button
                    onClick={() => setDocsSubTab('iframe')}
                    className={`px-6 py-2.5 rounded-lg text-sm font-medium transition-smooth ${
                      docsSubTab === 'iframe'
                        ? 'bg-meet-accent text-meet-bg'
                        : 'text-meet-text-secondary hover:text-meet-text-primary hover:bg-meet-bg-tertiary'
                    }`}
                  >
                    Iframe Integration
                  </button>
                </div>

                {/* API Reference */}
                {docsSubTab === 'api' && (
                  <>
                    <div className="glass rounded-xl overflow-hidden" style={{ height: 'calc(100vh - 300px)' }}>
                      <iframe
                        srcDoc={`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>MEET API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.10.0/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; background: #1a1a1a; }
    .swagger-ui { background: #1a1a1a; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info .title { color: #fff; }
    .swagger-ui .info .description { color: #ccc; }
    .swagger-ui .opblock-tag { color: #fff; border-bottom-color: #444; }
    .swagger-ui .opblock .opblock-summary-operation-id, .swagger-ui .opblock .opblock-summary-path, .swagger-ui .opblock .opblock-summary-path__deprecated { color: #ccc; }
    .swagger-ui .scheme-container { background: #2d2d2d; box-shadow: none; }
    .swagger-ui section.models { border-color: #444; }
    .swagger-ui section.models h4 { color: #fff; }
    .swagger-ui .model-title { color: #fff; }
    .swagger-ui .model { color: #ccc; }
    .swagger-ui .prop-type { color: #86b300; }
    .swagger-ui table thead tr th { color: #ccc; border-bottom-color: #444; }
    .swagger-ui table tbody tr td { color: #ccc; }
    .swagger-ui .responses-inner h4, .swagger-ui .responses-inner h5 { color: #fff; }
    .swagger-ui .response-col_status { color: #86b300; }
    .swagger-ui .parameter__name { color: #fff; }
    .swagger-ui .parameter__type { color: #86b300; }
    .swagger-ui .tab li { color: #ccc; }
    .swagger-ui .opblock-description-wrapper p { color: #ccc; }
    .swagger-ui .btn { border-color: #555; color: #fff; }
    .swagger-ui select { background: #2d2d2d; color: #fff; border-color: #555; }
    .swagger-ui input[type=text], .swagger-ui textarea { background: #2d2d2d; color: #fff; border-color: #555; }
    .swagger-ui .markdown p, .swagger-ui .markdown pre { color: #ccc; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.10.0/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '${getOpenApiUrl()}',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: 'BaseLayout',
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
        docExpansion: 'list',
        filter: true,
        tryItOutEnabled: true,
      });
    };
  </script>
</body>
</html>`}
                        title="API Documentation"
                        className="w-full h-full border-0"
                      />
                    </div>
                    <div className="glass rounded-xl p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-meet-text-secondary">
                          API Docs URL: <code className="bg-meet-bg-tertiary px-2 py-1 rounded text-meet-text-primary">{getOpenApiUrl()}</code>
                        </div>
                        <a
                          href={getOpenApiUrl()}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-meet-accent hover:underline flex items-center gap-1"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                          View JSON
                        </a>
                      </div>
                    </div>
                  </>
                )}

                {/* Iframe Integration Documentation */}
                {docsSubTab === 'iframe' && (
                  <div className="glass rounded-xl p-6 overflow-auto" style={{ maxHeight: 'calc(100vh - 300px)' }}>
                    <div className="prose prose-invert max-w-none">
                      <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl font-bold text-meet-text-primary">Iframe Integration Guide</h2>
                        <button
                          onClick={() => {
                            const markdown = `# MEET Iframe Integration Guide

Embed MEET video conferencing into your application using iframes. This is the simplest integration method and requires minimal setup.

## Quick Start

\`\`\`html
<iframe
  src="${window.location.origin}/?room=ROOM_CODE&name=PARTICIPANT_NAME"
  allow="camera; microphone; display-capture; autoplay"
  style="width: 100%; height: 600px; border: none;"
></iframe>
\`\`\`

## URL Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| \`room\` | Yes | Room code/ID to join |
| \`name\` | No | Pre-filled participant name |
| \`autojoin\` | No | Auto-join when both room and name provided (true/false) |
| \`quality\` | No | Video quality: auto, high, max, balanced, low |

## Integration Steps

1. **Create an API Key**
   Go to the Admin Panel > API Keys tab and create a new API key with appropriate permissions.

2. **Create a Room (Optional)**
   Use the API to create rooms programmatically with custom IDs:
   \`\`\`
   POST /api/rooms
   {
     "roomName": "my-meeting-123",
     "displayName": "Team Standup",
     "maxParticipants": 10
   }
   \`\`\`

3. **Embed the Iframe**
   Add the iframe to your application with the room code.

## Required Iframe Permissions

\`\`\`html
allow="camera; microphone; display-capture; autoplay"
\`\`\`

- \`camera\` - Access to user's camera
- \`microphone\` - Access to user's microphone
- \`display-capture\` - Screen sharing capability
- \`autoplay\` - Auto-play audio/video streams

## JavaScript Integration

\`\`\`javascript
class MeetIntegration {
  constructor(apiKey, serverUrl = '${window.location.origin}') {
    this.apiKey = apiKey;
    this.serverUrl = serverUrl;
  }

  // Create a new meeting room
  async createMeeting(options = {}) {
    const response = await fetch(\`\${this.serverUrl}/api/rooms\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey
      },
      body: JSON.stringify({
        roomName: options.roomId || \`meeting-\${Date.now()}\`,
        displayName: options.displayName || 'Video Meeting',
        maxParticipants: options.maxParticipants || 100
      })
    });
    return response.json();
  }

  // Generate join URL
  getJoinUrl(roomName, participantName) {
    const params = new URLSearchParams({ room: roomName });
    if (participantName) params.set('name', participantName);
    return \`\${this.serverUrl}/?\${params.toString()}\`;
  }

  // Embed meeting in a container
  embedMeeting(containerId, roomName, participantName) {
    const container = document.getElementById(containerId);
    const iframe = document.createElement('iframe');
    iframe.src = this.getJoinUrl(roomName, participantName);
    iframe.allow = 'camera; microphone; display-capture; autoplay';
    iframe.allowFullscreen = true;
    iframe.style.cssText = 'width: 100%; height: 100%; border: none;';
    container.innerHTML = '';
    container.appendChild(iframe);
    return iframe;
  }
}

// Usage
const meet = new MeetIntegration('your-api-key');
const meeting = await meet.createMeeting({ roomId: 'standup-123' });
meet.embedMeeting('meeting-container', meeting.room.name, 'John');
\`\`\`

## React Component Example

\`\`\`jsx
function MeetEmbed({ roomId, participantName }) {
  const [isLoading, setIsLoading] = useState(true);
  const meetUrl = \`${window.location.origin}/?room=\${roomId}\${
    participantName ? \`&name=\${encodeURIComponent(participantName)}\` : ''
  }\`;

  return (
    <div style={{ position: 'relative', width: '100%', height: '600px' }}>
      {isLoading && <div>Loading...</div>}
      <iframe
        src={meetUrl}
        allow="camera; microphone; display-capture; autoplay"
        allowFullScreen
        onLoad={() => setIsLoading(false)}
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
    </div>
  );
}
\`\`\`

## Troubleshooting

- **Camera/Microphone not working:** Ensure iframe has correct \`allow\` attributes and page is served over HTTPS.
- **Iframe not loading:** Check browser console for CSP errors. Verify CORS is configured properly.
- **Room not found:** Rooms are created on first join unless pre-created via API. Check room name uses only alphanumeric characters, hyphens, and underscores.
`;
                            const blob = new Blob([markdown], { type: 'text/markdown' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = 'MEET_Iframe_Integration.md';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                          }}
                          className="flex items-center gap-2 px-4 py-2 bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-medium rounded-lg transition-smooth text-sm"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          Download as Markdown
                        </button>
                      </div>
                      <p className="text-meet-text-secondary mb-6">
                        Embed MEET video conferencing into your application using iframes. This is the simplest integration method and requires minimal setup.
                      </p>

                      {/* Quick Start */}
                      <h3 className="text-xl font-semibold text-meet-text-primary mt-6 mb-3">Quick Start</h3>
                      <div className="bg-meet-bg-tertiary rounded-lg p-4 mb-4">
                        <pre className="text-sm text-meet-text-primary overflow-x-auto"><code>{`<iframe
  src="${window.location.origin}/?room=ROOM_CODE&name=PARTICIPANT_NAME"
  allow="camera; microphone; display-capture; autoplay"
  style="width: 100%; height: 600px; border: none;"
></iframe>`}</code></pre>
                      </div>

                      {/* URL Parameters */}
                      <h3 className="text-xl font-semibold text-meet-text-primary mt-6 mb-3">URL Parameters</h3>
                      <table className="w-full text-sm mb-6">
                        <thead>
                          <tr className="border-b border-meet-border">
                            <th className="text-left py-2 text-meet-text-secondary">Parameter</th>
                            <th className="text-left py-2 text-meet-text-secondary">Required</th>
                            <th className="text-left py-2 text-meet-text-secondary">Description</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="border-b border-meet-border/50">
                            <td className="py-2 font-mono text-meet-accent">room</td>
                            <td className="py-2 text-meet-text-primary">Yes</td>
                            <td className="py-2 text-meet-text-secondary">Room code/ID to join</td>
                          </tr>
                          <tr className="border-b border-meet-border/50">
                            <td className="py-2 font-mono text-meet-accent">name</td>
                            <td className="py-2 text-meet-text-primary">No</td>
                            <td className="py-2 text-meet-text-secondary">Pre-filled participant name</td>
                          </tr>
                          <tr className="border-b border-meet-border/50">
                            <td className="py-2 font-mono text-meet-accent">autojoin</td>
                            <td className="py-2 text-meet-text-primary">No</td>
                            <td className="py-2 text-meet-text-secondary">Auto-join when both room and name provided (true/false)</td>
                          </tr>
                          <tr className="border-b border-meet-border/50">
                            <td className="py-2 font-mono text-meet-accent">quality</td>
                            <td className="py-2 text-meet-text-primary">No</td>
                            <td className="py-2 text-meet-text-secondary">Video quality: auto, high, max, balanced, low</td>
                          </tr>
                        </tbody>
                      </table>

                      {/* Integration Steps */}
                      <h3 className="text-xl font-semibold text-meet-text-primary mt-6 mb-3">Integration Steps</h3>
                      <ol className="list-decimal list-inside space-y-4 text-meet-text-secondary">
                        <li>
                          <strong className="text-meet-text-primary">Create an API Key</strong>
                          <p className="ml-6 mt-1">Go to the "API Keys" tab and create a new API key with appropriate permissions.</p>
                        </li>
                        <li>
                          <strong className="text-meet-text-primary">Create a Room (Optional)</strong>
                          <p className="ml-6 mt-1">Use the API to create rooms programmatically with custom IDs.</p>
                          <div className="bg-meet-bg-tertiary rounded-lg p-3 ml-6 mt-2">
                            <pre className="text-xs text-meet-text-primary overflow-x-auto"><code>{`POST /api/rooms
{
  "roomName": "my-meeting-123",
  "displayName": "Team Standup",
  "maxParticipants": 10
}`}</code></pre>
                          </div>
                        </li>
                        <li>
                          <strong className="text-meet-text-primary">Embed the Iframe</strong>
                          <p className="ml-6 mt-1">Add the iframe to your application with the room code.</p>
                        </li>
                      </ol>

                      {/* Required Permissions */}
                      <h3 className="text-xl font-semibold text-meet-text-primary mt-6 mb-3">Required Iframe Permissions</h3>
                      <div className="bg-meet-bg-tertiary rounded-lg p-4 mb-4">
                        <code className="text-sm text-meet-text-primary">allow="camera; microphone; display-capture; autoplay"</code>
                      </div>
                      <ul className="list-disc list-inside space-y-1 text-meet-text-secondary mb-6">
                        <li><code className="text-meet-accent">camera</code> - Access to user's camera</li>
                        <li><code className="text-meet-accent">microphone</code> - Access to user's microphone</li>
                        <li><code className="text-meet-accent">display-capture</code> - Screen sharing capability</li>
                        <li><code className="text-meet-accent">autoplay</code> - Auto-play audio/video streams</li>
                      </ul>

                      {/* JavaScript Example */}
                      <h3 className="text-xl font-semibold text-meet-text-primary mt-6 mb-3">JavaScript Integration</h3>
                      <div className="bg-meet-bg-tertiary rounded-lg p-4 mb-4">
                        <pre className="text-xs text-meet-text-primary overflow-x-auto"><code>{`class MeetIntegration {
  constructor(apiKey, serverUrl = '${window.location.origin}') {
    this.apiKey = apiKey;
    this.serverUrl = serverUrl;
  }

  // Create a new meeting room
  async createMeeting(options = {}) {
    const response = await fetch(\`\${this.serverUrl}/api/rooms\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey
      },
      body: JSON.stringify({
        roomName: options.roomId || \`meeting-\${Date.now()}\`,
        displayName: options.displayName || 'Video Meeting',
        maxParticipants: options.maxParticipants || 100
      })
    });
    return response.json();
  }

  // Generate join URL
  getJoinUrl(roomName, participantName) {
    const params = new URLSearchParams({ room: roomName });
    if (participantName) params.set('name', participantName);
    return \`\${this.serverUrl}/?\${params.toString()}\`;
  }

  // Embed meeting in a container
  embedMeeting(containerId, roomName, participantName) {
    const container = document.getElementById(containerId);
    const iframe = document.createElement('iframe');
    iframe.src = this.getJoinUrl(roomName, participantName);
    iframe.allow = 'camera; microphone; display-capture; autoplay';
    iframe.allowFullscreen = true;
    iframe.style.cssText = 'width: 100%; height: 100%; border: none;';
    container.innerHTML = '';
    container.appendChild(iframe);
    return iframe;
  }
}

// Usage
const meet = new MeetIntegration('your-api-key');
const meeting = await meet.createMeeting({ roomId: 'standup-123' });
meet.embedMeeting('meeting-container', meeting.room.name, 'John');`}</code></pre>
                      </div>

                      {/* React Example */}
                      <h3 className="text-xl font-semibold text-meet-text-primary mt-6 mb-3">React Component Example</h3>
                      <div className="bg-meet-bg-tertiary rounded-lg p-4 mb-4">
                        <pre className="text-xs text-meet-text-primary overflow-x-auto"><code>{`function MeetEmbed({ roomId, participantName }) {
  const [isLoading, setIsLoading] = useState(true);
  const meetUrl = \`${window.location.origin}/?room=\${roomId}\${
    participantName ? \`&name=\${encodeURIComponent(participantName)}\` : ''
  }\`;

  return (
    <div style={{ position: 'relative', width: '100%', height: '600px' }}>
      {isLoading && <div>Loading...</div>}
      <iframe
        src={meetUrl}
        allow="camera; microphone; display-capture; autoplay"
        allowFullScreen
        onLoad={() => setIsLoading(false)}
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
    </div>
  );
}`}</code></pre>
                      </div>

                      {/* Troubleshooting */}
                      <h3 className="text-xl font-semibold text-meet-text-primary mt-6 mb-3">Troubleshooting</h3>
                      <ul className="list-disc list-inside space-y-2 text-meet-text-secondary">
                        <li><strong className="text-meet-text-primary">Camera/Microphone not working:</strong> Ensure iframe has correct <code className="text-meet-accent">allow</code> attributes and page is served over HTTPS.</li>
                        <li><strong className="text-meet-text-primary">Iframe not loading:</strong> Check browser console for CSP errors. Verify CORS is configured properly.</li>
                        <li><strong className="text-meet-text-primary">Room not found:</strong> Rooms are created on first join unless pre-created via API. Check room name uses only alphanumeric characters, hyphens, and underscores.</li>
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default AdminPanel;
