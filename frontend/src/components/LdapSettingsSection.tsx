import { useCallback, useEffect, useState, FormEvent } from 'react';
import { useAdminStore } from '../stores/adminStore';
import {
  getLdapSettings,
  updateLdapSettings,
  deleteLdapSettings,
  testLdap,
  searchLdapUsers,
  listLdapAdmins,
  addLdapAdmin,
  removeLdapAdmin,
  disableLocalAccount,
  enableLocalAccount,
  type LdapStatus,
  type LdapUpdate,
  type LdapUserResult,
  type LdapAdminInfo,
} from '../lib/livekit';

interface Props {
  token: string;
}

const inputClass =
  'w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-2 text-sm text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none';

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      disabled={disabled}
      className={`relative inline-flex h-7 w-14 shrink-0 items-center rounded-full transition-colors ${
        on ? 'bg-meet-success' : 'bg-meet-bg-tertiary'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-8' : 'translate-x-1'}`} />
    </button>
  );
}

/**
 * Directory (LDAP / LDAPS) integration. Off by default.
 *
 * Two independent switches once a connection is saved and enabled:
 *  - Require directory sign-in for the meeting frontend.
 *  - Let selected directory users ("LDAP admins") into this admin panel.
 *    An LDAP admin, once signed in, may switch the local account off.
 */
function LdapSettingsSection({ token }: Props) {
  const principal = useAdminStore((s) => s.principal);
  const logout = useAdminStore((s) => s.logout);
  const isLdapAdmin = principal.startsWith('ldap:');

  const [status, setStatus] = useState<LdapStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [form, setForm] = useState<LdapUpdate>({});
  const [bindPassword, setBindPassword] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const [admins, setAdmins] = useState<LdapAdminInfo[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LdapUserResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [confirmDisableLocal, setConfirmDisableLocal] = useState(false);

  const applyStatus = useCallback((s: LdapStatus) => {
    setStatus(s);
    const { hasBindPassword: _hp, ...rest } = s.settings;
    void _hp;
    setForm(rest);
    setBindPassword('');
    setDirty(false);
  }, []);

  const reload = useCallback(async () => {
    const [s, a] = await Promise.all([getLdapSettings(token), listLdapAdmins(token)]);
    applyStatus(s);
    setAdmins(a);
  }, [token, applyStatus]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload()
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load LDAP settings'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reload]);

  const set = <K extends keyof LdapUpdate>(k: K, v: LdapUpdate[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  const flash = (msg: string) => { setError(''); setNotice(msg); };
  const fail = (e: unknown, fallback: string) => { setNotice(''); setError(e instanceof Error ? e.message : fallback); };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const s = await updateLdapSettings(token, { ...form, ...(bindPassword ? { bindPassword } : {}) });
      applyStatus(s);
      flash('LDAP settings saved.');
    } catch (err) {
      fail(err, 'Failed to save LDAP settings');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (k: 'enabled' | 'requireForFrontend' | 'adminsEnabled', v: boolean) => {
    try {
      const s = await updateLdapSettings(token, { [k]: v });
      applyStatus(s);
      flash(
        k === 'enabled' ? (v ? 'LDAP enabled.' : 'LDAP disabled.')
        : k === 'requireForFrontend' ? (v ? 'Participants must now sign in with a directory account.' : 'Directory sign-in is no longer required for participants.')
        : (v ? 'LDAP admins can now sign in to this panel.' : 'LDAP admin sign-in turned off.'),
      );
    } catch (err) {
      fail(err, 'Failed to update');
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const r = await testLdap(token);
      flash(r.message);
    } catch (err) {
      fail(err, 'LDAP test failed');
    } finally {
      setTesting(false);
    }
  };

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    setSearching(true);
    try {
      setResults(await searchLdapUsers(token, query));
      setError('');
    } catch (err) {
      fail(err, 'Directory search failed');
    } finally {
      setSearching(false);
    }
  };

  const handleAdd = async (u: LdapUserResult) => {
    try {
      const a = await addLdapAdmin(token, u.dn);
      setAdmins((list) => [...list, a]);
      setResults((r) => r ? r.map((x) => x.dn === u.dn ? { ...x, isAdmin: true } : x) : r);
      const s = await getLdapSettings(token);
      setStatus(s);
      flash(`${a.displayName || a.username} can now sign in as an admin.`);
    } catch (err) {
      fail(err, 'Failed to add LDAP admin');
    }
  };

  const handleRemove = async (a: LdapAdminInfo) => {
    try {
      await removeLdapAdmin(token, a.id);
      setAdmins((list) => list.filter((x) => x.id !== a.id));
      setResults((r) => r ? r.map((x) => x.dn.toLowerCase() === a.dn.toLowerCase() ? { ...x, isAdmin: false } : x) : r);
      const s = await getLdapSettings(token);
      setStatus(s);
      flash(`${a.displayName || a.username} removed from admins.`);
      if (principal.toLowerCase() === `ldap:${a.dn}`.toLowerCase()) logout();
    } catch (err) {
      fail(err, 'Failed to remove LDAP admin');
    }
  };

  const handleDisableLocal = async () => {
    try {
      await disableLocalAccount(token);
      setConfirmDisableLocal(false);
      await reload();
      flash('Local admin account disabled. Only LDAP admins can sign in now.');
    } catch (err) {
      fail(err, 'Failed to disable the local account');
    }
  };

  const handleEnableLocal = async () => {
    try {
      await enableLocalAccount(token);
      await reload();
      flash('Local admin account re-enabled.');
    } catch (err) {
      fail(err, 'Failed to enable the local account');
    }
  };

  const handleDelete = async () => {
    try {
      const s = await deleteLdapSettings(token);
      applyStatus(s);
      setAdmins([]);
      setResults(null);
      setConfirmRemove(false);
      flash('LDAP settings removed.');
      if (isLdapAdmin) logout();
    } catch (err) {
      fail(err, 'Failed to remove LDAP settings');
    }
  };

  const s = status?.settings;
  const active = !!status?.active;

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h3 className="text-lg font-semibold text-meet-text-primary">Directory (LDAP / LDAPS)</h3>
          <p className="text-sm text-meet-text-secondary mt-1">
            Off by default. Connect to Active Directory, OpenLDAP or any LDAP server, then choose what it is used for:
            requiring a directory sign-in before anyone can join meetings, and/or letting chosen directory users into this admin panel.
          </p>
        </div>
        <span className={`shrink-0 text-xs font-medium px-2 py-1 rounded-full border ${
          active ? 'text-meet-success border-meet-success/40 bg-meet-success/10'
          : status?.configured ? 'text-yellow-500 border-yellow-500/40 bg-yellow-500/10'
          : 'text-meet-text-tertiary border-meet-border'
        }`}>
          {active ? 'Enabled' : status?.configured ? 'Saved · disabled' : 'Not configured'}
        </span>
      </div>

      {error && <div className="bg-meet-error/10 border border-meet-error/30 rounded-lg px-4 py-2 text-meet-error text-sm mb-3">{error}</div>}
      {notice && <div className="bg-meet-accent/10 border border-meet-accent/30 rounded-lg px-4 py-2 text-meet-accent text-sm mb-3">{notice}</div>}

      {loading || !s ? (
        <div className="flex items-center justify-center h-24">
          <div className="animate-spin h-6 w-6 border-4 border-meet-accent border-t-transparent rounded-full"></div>
        </div>
      ) : (
        <>
          {/* Connection */}
          <form onSubmit={handleSave} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs text-meet-text-tertiary mb-1">Server URL</label>
                <input type="text" value={form.url ?? ''} onChange={(e) => set('url', e.target.value)}
                  placeholder="ldaps://ldap.example.com:636" className={inputClass} autoComplete="off" />
              </div>
              <div>
                <label className="block text-xs text-meet-text-tertiary mb-1">Timeout (ms)</label>
                <input type="number" min={1000} max={60000} step={500} value={form.timeoutMs ?? 8000}
                  onChange={(e) => set('timeoutMs', Number(e.target.value))} className={inputClass} />
              </div>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-meet-text-secondary">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!form.startTls} onChange={(e) => set('startTls', e.target.checked)}
                  disabled={(form.url ?? '').toLowerCase().startsWith('ldaps://')} className="accent-meet-accent" />
                StartTLS on ldap:// (not needed for ldaps://)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.tlsRejectUnauthorized !== false} onChange={(e) => set('tlsRejectUnauthorized', e.target.checked)}
                  className="accent-meet-accent" />
                Verify the server certificate
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-meet-text-tertiary mb-1">Bind DN <span className="opacity-60">(service account, blank = anonymous)</span></label>
                <input type="text" value={form.bindDn ?? ''} onChange={(e) => set('bindDn', e.target.value)}
                  placeholder="cn=meet,ou=services,dc=example,dc=com" className={inputClass} autoComplete="off" />
              </div>
              <div>
                <label className="block text-xs text-meet-text-tertiary mb-1">Bind password</label>
                <input type="password" value={bindPassword} onChange={(e) => { setBindPassword(e.target.value); setDirty(true); }}
                  placeholder={s.hasBindPassword ? '•••••••• (unchanged)' : ''} className={inputClass} autoComplete="new-password" />
              </div>
            </div>

            <div>
              <label className="block text-xs text-meet-text-tertiary mb-1">User search base DN</label>
              <input type="text" value={form.baseDn ?? ''} onChange={(e) => set('baseDn', e.target.value)}
                placeholder="ou=people,dc=example,dc=com" className={inputClass} autoComplete="off" />
            </div>

            <button type="button" onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs text-meet-accent hover:text-meet-accent-light">
              {showAdvanced ? 'Hide' : 'Show'} filters, attributes and CA certificate
            </button>

            {showAdvanced && (
              <div className="space-y-3 border-l-2 border-meet-border pl-4">
                <div>
                  <label className="block text-xs text-meet-text-tertiary mb-1">User filter <span className="opacity-60">({'{{username}}'} is replaced with what the user typed)</span></label>
                  <input type="text" value={form.userFilter ?? ''} onChange={(e) => set('userFilter', e.target.value)} className={`${inputClass} font-mono text-xs`} />
                </div>
                <div>
                  <label className="block text-xs text-meet-text-tertiary mb-1">Admin picker search filter <span className="opacity-60">({'{{q}}'} is the search text)</span></label>
                  <input type="text" value={form.searchFilter ?? ''} onChange={(e) => set('searchFilter', e.target.value)} className={`${inputClass} font-mono text-xs`} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-meet-text-tertiary mb-1">Username attribute</label>
                    <input type="text" value={form.usernameAttribute ?? ''} onChange={(e) => set('usernameAttribute', e.target.value)} placeholder="uid or sAMAccountName" className={inputClass} />
                  </div>
                  <div>
                    <label className="block text-xs text-meet-text-tertiary mb-1">Display name attribute</label>
                    <input type="text" value={form.displayNameAttribute ?? ''} onChange={(e) => set('displayNameAttribute', e.target.value)} placeholder="displayName" className={inputClass} />
                  </div>
                  <div>
                    <label className="block text-xs text-meet-text-tertiary mb-1">Email attribute</label>
                    <input type="text" value={form.emailAttribute ?? ''} onChange={(e) => set('emailAttribute', e.target.value)} placeholder="mail" className={inputClass} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-meet-text-tertiary mb-1">CA certificate (PEM) <span className="opacity-60">for a private CA on LDAPS / StartTLS</span></label>
                  <textarea value={form.caCert ?? ''} onChange={(e) => set('caCert', e.target.value)} rows={4}
                    placeholder="-----BEGIN CERTIFICATE-----" className={`${inputClass} font-mono text-xs`} />
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <button type="submit" disabled={saving || !form.url || !form.baseDn}
                className="bg-meet-accent hover:bg-meet-accent-dark disabled:opacity-50 text-meet-bg font-medium px-4 py-2 rounded-xl transition-smooth text-sm">
                {saving ? 'Saving…' : dirty ? 'Save connection' : 'Saved'}
              </button>
              <button type="button" onClick={handleTest} disabled={testing || dirty || !status?.configured}
                title={dirty ? 'Save first' : ''}
                className="bg-meet-bg-tertiary hover:bg-meet-bg-elevated border border-meet-border disabled:opacity-50 text-meet-text-primary font-medium px-4 py-2 rounded-xl transition-smooth text-sm">
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {status?.configured && (
                confirmRemove ? (
                  <span className="flex items-center gap-2 text-sm">
                    <span className="text-meet-text-secondary">Remove LDAP settings and all LDAP admins?</span>
                    <button type="button" onClick={handleDelete} className="text-meet-error hover:underline">Yes, remove</button>
                    <button type="button" onClick={() => setConfirmRemove(false)} className="text-meet-text-tertiary hover:underline">Cancel</button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirmRemove(true)} className="text-meet-error hover:underline text-sm px-2">Remove</button>
                )
              )}
            </div>
          </form>

          {/* Switches */}
          <div className="mt-5 space-y-3">
            <div className="flex items-center justify-between gap-4 bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3">
              <div>
                <div className="text-sm font-medium text-meet-text-primary">Enable LDAP</div>
                <div className="text-xs text-meet-text-tertiary">Master switch. Nothing below applies until this is on.</div>
              </div>
              <Toggle on={!!s.enabled} disabled={!status?.configured || dirty} onChange={(v) => handleToggle('enabled', v)} />
            </div>
            <div className="flex items-center justify-between gap-4 bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3">
              <div>
                <div className="text-sm font-medium text-meet-text-primary">Require directory sign-in to use the meeting frontend</div>
                <div className="text-xs text-meet-text-tertiary">Participants see an LDAP sign-in before the join screen. API-key integrations are not affected.</div>
              </div>
              <Toggle on={!!s.requireForFrontend} disabled={!s.enabled} onChange={(v) => handleToggle('requireForFrontend', v)} />
            </div>
            <div className="flex items-center justify-between gap-4 bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3">
              <div>
                <div className="text-sm font-medium text-meet-text-primary">Allow LDAP admins to sign in to this panel</div>
                <div className="text-xs text-meet-text-tertiary">Only the directory users listed below. They sign in with their directory username and password.</div>
              </div>
              <Toggle on={!!s.adminsEnabled} disabled={!s.enabled || (!status?.localAccountEnabled)} onChange={(v) => handleToggle('adminsEnabled', v)} />
            </div>
          </div>

          {/* LDAP admins */}
          {s.enabled && (
            <div className="mt-5">
              <h4 className="text-sm font-semibold text-meet-text-primary mb-2">LDAP admins</h4>
              {admins.length === 0 ? (
                <p className="text-sm text-meet-text-tertiary mb-3">No directory users have admin access yet. Search below to add some.</p>
              ) : (
                <ul className="space-y-2 mb-3">
                  {admins.map((a) => (
                    <li key={a.id} className="flex items-center justify-between bg-meet-bg-tertiary border border-meet-border rounded-lg px-4 py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-meet-text-primary truncate">
                          {a.displayName || a.username}
                          {a.email && <span className="text-meet-text-tertiary"> · {a.email}</span>}
                        </div>
                        <div className="text-xs text-meet-text-tertiary truncate" title={a.dn}>
                          {a.dn} · {a.lastLoginAt ? `last sign-in ${new Date(a.lastLoginAt).toLocaleDateString()}` : 'never signed in'}
                        </div>
                      </div>
                      <button type="button" onClick={() => handleRemove(a)} className="text-meet-error hover:underline text-sm shrink-0 ml-3">Remove</button>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={handleSearch} className="flex gap-2">
                <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search the directory by name, username or email" className={inputClass} />
                <button type="submit" disabled={searching}
                  className="bg-meet-bg-tertiary hover:bg-meet-bg-elevated border border-meet-border disabled:opacity-50 text-meet-text-primary font-medium px-4 py-2 rounded-xl transition-smooth text-sm whitespace-nowrap">
                  {searching ? 'Searching…' : 'Search'}
                </button>
              </form>

              {results && (
                <div className="mt-2 border border-meet-border rounded-xl divide-y divide-meet-border max-h-64 overflow-y-auto">
                  {results.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-meet-text-tertiary">No matching directory users.</div>
                  ) : results.map((u) => (
                    <div key={u.dn} className="flex items-center justify-between px-4 py-2">
                      <div className="min-w-0">
                        <div className="text-sm text-meet-text-primary truncate">
                          {u.displayName || u.username}
                          {u.username && <span className="text-meet-text-tertiary"> · {u.username}</span>}
                          {u.email && <span className="text-meet-text-tertiary"> · {u.email}</span>}
                        </div>
                        <div className="text-xs text-meet-text-tertiary truncate" title={u.dn}>{u.dn}</div>
                      </div>
                      {u.isAdmin ? (
                        <span className="text-xs text-meet-success shrink-0 ml-3">Admin</span>
                      ) : (
                        <button type="button" onClick={() => handleAdd(u)} className="text-meet-accent hover:underline text-sm shrink-0 ml-3">Make admin</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Local account switch */}
          <div className="mt-5 bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-meet-text-primary">
                  Local admin account: {status?.localAccountEnabled ? <span className="text-meet-success">enabled</span> : <span className="text-meet-error">disabled</span>}
                </div>
                <div className="text-xs text-meet-text-tertiary">
                  {isLdapAdmin
                    ? 'As an LDAP admin you can switch the built-in account (password, passkeys, email codes) off. Only LDAP admins can sign in afterwards.'
                    : 'Only a signed-in LDAP admin can disable the built-in account.'}
                  {' '}Recovery from the server: <code>reset-admin.js --enable-local</code>.
                </div>
              </div>
              {isLdapAdmin && (
                status?.localAccountEnabled ? (
                  confirmDisableLocal ? (
                    <span className="flex items-center gap-2 text-sm shrink-0">
                      <button type="button" onClick={handleDisableLocal} className="text-meet-error hover:underline">Yes, disable</button>
                      <button type="button" onClick={() => setConfirmDisableLocal(false)} className="text-meet-text-tertiary hover:underline">Cancel</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirmDisableLocal(true)} disabled={!s.adminsEnabled}
                      className="text-meet-error hover:underline text-sm shrink-0 disabled:opacity-50">Disable local account</button>
                  )
                ) : (
                  <button type="button" onClick={handleEnableLocal} className="text-meet-accent hover:underline text-sm shrink-0">Enable local account</button>
                )
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default LdapSettingsSection;
