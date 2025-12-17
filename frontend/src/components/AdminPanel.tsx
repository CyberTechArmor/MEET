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
  getJoinLink,
  formatRoomCode,
  updateRoomDisplayName,
  WEBHOOK_EVENTS,
} from '../lib/livekit';
import type { ApiKeyInfo, WebhookInfo, CreateApiKeyResponse, CreateWebhookResponse, RoomInfo } from '../lib/livekit';

type TabType = 'dashboard' | 'api-keys' | 'webhooks' | 'docs';

interface AdminPanelProps {
  onClose: () => void;
}

// Polling interval for real-time updates (5 seconds)
const POLL_INTERVAL = 5000;

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
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

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

  // Check session validity on mount
  useEffect(() => {
    if (isAuthenticated && !isSessionValid()) {
      logout();
    }
  }, [isAuthenticated, isSessionValid, logout]);

  // Load data when authenticated
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [token, setStats, setRooms, setApiKeys, setWebhooks, setLoading, setError]);

  // Initial data load
  useEffect(() => {
    if (isAuthenticated && token) {
      loadData(true);
    }
  }, [isAuthenticated, token, loadData]);

  // Real-time polling for data updates
  useEffect(() => {
    if (isAuthenticated && token) {
      // Start polling
      pollIntervalRef.current = setInterval(() => {
        loadData(false); // Don't show loading indicator for polls
      }, POLL_INTERVAL);

      return () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      };
    }
  }, [isAuthenticated, token, loadData]);

  // Handle login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');

    try {
      const response = await adminLogin(password);
      setAuth(response.token, response.expiresAt, response.isFirstLogin);
      setPassword('');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed');
    }
  };

  // Handle logout
  const handleLogout = async () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (token) {
      await adminLogout(token);
    }
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
      await loadData(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    }
  };

  // Handle API key revocation
  const handleRevokeApiKey = async (keyId: string) => {
    if (!token) return;

    try {
      await revokeApiKey(token, keyId);
      await loadData(false);
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
      await loadData(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create webhook');
    }
  };

  // Handle webhook toggle
  const handleToggleWebhook = async (webhook: WebhookInfo) => {
    if (!token) return;

    try {
      await updateWebhook(token, webhook.id, { enabled: !webhook.enabled });
      await loadData(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update webhook');
    }
  };

  // Handle webhook deletion
  const handleDeleteWebhook = async (webhookId: string) => {
    if (!token) return;

    try {
      await deleteWebhook(token, webhookId);
      await loadData(false);
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
      await loadData(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update display name');
    }
  };

  // Handle cancel edit
  const handleCancelEdit = () => {
    setEditingRoom(null);
    setEditingDisplayName('');
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
            Enter the admin password to access the admin panel. If this is your first login, the password you enter will be set as the admin password.
          </p>

          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Admin password"
              className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
              autoFocus
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
            <span className="text-xs text-meet-success flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-meet-success animate-pulse"></span>
              Live
            </span>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => loadData(true)}
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
          {(['dashboard', 'api-keys', 'webhooks', 'docs'] as TabType[]).map((tab) => (
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

            {/* Docs Tab - Swagger UI */}
            {activeTab === 'docs' && (
              <div className="space-y-6">
                <div className="glass rounded-xl overflow-hidden" style={{ height: 'calc(100vh - 250px)' }}>
                  <iframe
                    src={`https://petstore.swagger.io/?url=${encodeURIComponent(getOpenApiUrl())}`}
                    title="API Documentation"
                    className="w-full h-full border-0"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  />
                </div>
                <div className="glass rounded-xl p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-meet-text-secondary">
                      OpenAPI Spec URL: <code className="bg-meet-bg-tertiary px-2 py-1 rounded text-meet-text-primary">{getOpenApiUrl()}</code>
                    </div>
                    <a
                      href={getOpenApiUrl()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-meet-accent hover:underline flex items-center gap-1"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download YAML
                    </a>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default AdminPanel;
