import { useState, useEffect, useCallback } from 'react';
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
  WEBHOOK_EVENTS,
} from '../lib/livekit';
import type { ApiKeyInfo, WebhookInfo, CreateApiKeyResponse, CreateWebhookResponse } from '../lib/livekit';

type TabType = 'dashboard' | 'api-keys' | 'webhooks' | 'docs';

interface AdminPanelProps {
  onClose: () => void;
}

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

  // Check session validity on mount
  useEffect(() => {
    if (isAuthenticated && !isSessionValid()) {
      logout();
    }
  }, [isAuthenticated, isSessionValid, logout]);

  // Load data when authenticated
  const loadData = useCallback(async () => {
    if (!token) return;

    setLoading(true);
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
      setLoading(false);
    }
  }, [token, setStats, setRooms, setApiKeys, setWebhooks, setLoading, setError]);

  useEffect(() => {
    if (isAuthenticated && token) {
      loadData();
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
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key');
    }
  };

  // Handle API key revocation
  const handleRevokeApiKey = async (keyId: string) => {
    if (!token) return;

    try {
      await revokeApiKey(token, keyId);
      await loadData();
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
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create webhook');
    }
  };

  // Handle webhook toggle
  const handleToggleWebhook = async (webhook: WebhookInfo) => {
    if (!token) return;

    try {
      await updateWebhook(token, webhook.id, { enabled: !webhook.enabled });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update webhook');
    }
  };

  // Handle webhook deletion
  const handleDeleteWebhook = async (webhookId: string) => {
    if (!token) return;

    try {
      await deleteWebhook(token, webhookId);
      await loadData();
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
          </div>
          <div className="flex items-center gap-4">
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
                    <div className="space-y-2">
                      {rooms.map((room) => (
                        <div
                          key={room.name}
                          className="flex items-center justify-between bg-meet-bg-tertiary rounded-lg px-4 py-3"
                        >
                          <div>
                            <span className="font-mono text-meet-text-primary">{room.name}</span>
                          </div>
                          <div className="flex items-center gap-4 text-sm text-meet-text-secondary">
                            <span>{room.numParticipants} participant{room.numParticipants !== 1 ? 's' : ''}</span>
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

            {/* Docs Tab */}
            {activeTab === 'docs' && (
              <div className="space-y-6">
                <div className="glass rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-meet-text-primary mb-4">API Documentation</h3>
                  <p className="text-meet-text-secondary mb-4">
                    The MEET API is documented using OpenAPI 3.0 specification. You can view the full specification
                    or import it into tools like Swagger UI, Postman, or Insomnia.
                  </p>
                  <div className="space-y-3">
                    <a
                      href={getOpenApiUrl()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-semibold py-2 px-4 rounded-lg transition-smooth inline-block"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      View OpenAPI Spec
                    </a>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(getOpenApiUrl());
                        alert('URL copied to clipboard!');
                      }}
                      className="flex items-center gap-2 bg-meet-bg-tertiary hover:bg-meet-bg-elevated text-meet-text-primary font-medium py-2 px-4 rounded-lg transition-smooth"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy OpenAPI URL
                    </button>
                  </div>
                </div>

                <div className="glass rounded-xl p-6">
                  <h3 className="text-lg font-semibold text-meet-text-primary mb-4">Quick Reference</h3>
                  <div className="space-y-4 text-sm">
                    <div>
                      <div className="text-meet-text-secondary mb-1">Base URL:</div>
                      <code className="bg-meet-bg-tertiary px-2 py-1 rounded text-meet-text-primary">
                        {window.location.origin}/api
                      </code>
                    </div>
                    <div>
                      <div className="text-meet-text-secondary mb-1">Authentication:</div>
                      <code className="bg-meet-bg-tertiary px-2 py-1 rounded text-meet-text-primary block">
                        Authorization: Bearer YOUR_TOKEN
                      </code>
                      <div className="text-meet-text-tertiary mt-1">or</div>
                      <code className="bg-meet-bg-tertiary px-2 py-1 rounded text-meet-text-primary block mt-1">
                        X-API-Key: YOUR_API_KEY
                      </code>
                    </div>
                    <div>
                      <div className="text-meet-text-secondary mb-2">Key Endpoints:</div>
                      <ul className="space-y-1 text-meet-text-tertiary">
                        <li><code className="text-meet-text-primary">POST /api/token</code> - Generate meeting token</li>
                        <li><code className="text-meet-text-primary">GET /api/room-code</code> - Generate room code</li>
                        <li><code className="text-meet-text-primary">GET /api/rooms</code> - List active rooms</li>
                        <li><code className="text-meet-text-primary">GET /api/admin/stats</code> - Server statistics</li>
                        <li><code className="text-meet-text-primary">POST /api/admin/api-keys</code> - Create API key</li>
                        <li><code className="text-meet-text-primary">POST /api/admin/webhooks</code> - Create webhook</li>
                      </ul>
                    </div>
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
