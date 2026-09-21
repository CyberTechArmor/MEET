import { useCallback, useEffect, useState, FormEvent } from 'react';
import { useAdminStore } from '../stores/adminStore';
import {
  getAdminProfile,
  updateAdminProfile,
  revokeOtherAdminSessions,
  type AdminProfile,
} from '../lib/livekit';

interface Props {
  token: string;
  /** Bumped by the parent when passkeys / SMTP / LDAP change so the summary refreshes. */
  refreshKey?: number;
}

const inputClass =
  'w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-2 text-sm text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none';

/**
 * "You": who is signed in, how this account can sign in, and — for the
 * local account — username / password changes and signing out elsewhere.
 */
function ProfileSection({ token, refreshKey = 0 }: Props) {
  const logout = useAdminStore((s) => s.logout);
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [username, setUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    const p = await getAdminProfile(token);
    setProfile(p);
    setUsername(p.username);
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load profile'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load, refreshKey]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (newPassword && newPassword !== confirmPassword) {
      setError('New password and confirmation do not match');
      return;
    }
    if (newPassword && newPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }
    setSaving(true);
    try {
      const r = await updateAdminProfile(token, {
        ...(profile && username.trim() !== profile.username ? { username: username.trim() } : {}),
        currentPassword,
        ...(newPassword ? { newPassword } : {}),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      await load();
      const what = [r.changed.username && 'username', r.changed.password && 'password'].filter(Boolean).join(' and ');
      setNotice(`Updated ${what}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleRevokeOthers = async () => {
    setError('');
    setNotice('');
    setRevoking(true);
    try {
      const r = await revokeOtherAdminSessions(token);
      await load();
      setNotice(r.revoked === 0 ? 'No other sessions were active.' : `Signed out ${r.revoked} other session${r.revoked === 1 ? '' : 's'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign out other sessions');
    } finally {
      setRevoking(false);
    }
  };

  const p = profile;
  const dirty = !!p && (username.trim() !== p.username || newPassword.length > 0);

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h3 className="text-lg font-semibold text-meet-text-primary">Your account</h3>
          <p className="text-sm text-meet-text-secondary mt-1">
            Who you are signed in as, and how this account can sign in. Passkeys, email codes and the directory are managed in the cards below.
          </p>
        </div>
        {p && (
          <span className="shrink-0 text-xs font-medium px-2 py-1 rounded-full border text-meet-text-secondary border-meet-border">
            {p.kind === 'ldap' ? 'LDAP admin' : p.kind === 'apikey' ? 'API key' : 'Local account'}
          </span>
        )}
      </div>

      {error && <div className="bg-meet-error/10 border border-meet-error/30 rounded-lg px-4 py-2 text-meet-error text-sm mb-3">{error}</div>}
      {notice && <div className="bg-meet-accent/10 border border-meet-accent/30 rounded-lg px-4 py-2 text-meet-accent text-sm mb-3">{notice}</div>}

      {loading || !p ? (
        <div className="flex items-center justify-center h-24">
          <div className="animate-spin h-6 w-6 border-4 border-meet-accent border-t-transparent rounded-full"></div>
        </div>
      ) : (
        <>
          {/* Identity */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <div className="bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3">
              <div className="text-xs text-meet-text-tertiary">Signed in as</div>
              <div className="text-sm text-meet-text-primary truncate" title={p.dn || p.username}>{p.displayName || p.username}</div>
              {p.email && <div className="text-xs text-meet-text-tertiary truncate">{p.email}</div>}
              {p.dn && <div className="text-xs text-meet-text-tertiary truncate" title={p.dn}>{p.dn}</div>}
            </div>
            <div className="bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3">
              <div className="text-xs text-meet-text-tertiary">Active sessions</div>
              <div className="text-sm text-meet-text-primary">{p.activeSessions}</div>
              {p.kind !== 'apikey' && (
                <button type="button" onClick={handleRevokeOthers} disabled={revoking || p.activeSessions <= 1}
                  className="text-xs text-meet-accent hover:text-meet-accent-light disabled:opacity-50">
                  {revoking ? 'Signing out…' : 'Sign out other sessions'}
                </button>
              )}
            </div>
            <div className="bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3">
              <div className="text-xs text-meet-text-tertiary">Sign-in methods</div>
              <ul className="text-xs text-meet-text-secondary space-y-0.5 mt-0.5">
                <li>Password: <span className={p.passwordLoginEnabled ? 'text-meet-success' : 'text-meet-text-tertiary'}>{p.localAccountEnabled ? (p.passwordLoginEnabled ? 'on' : 'off (email sign-in verified)') : 'off (local account disabled)'}</span></li>
                <li>Passkeys: <span className={p.passkeyCount > 0 ? 'text-meet-success' : 'text-meet-text-tertiary'}>{p.passkeyCount}</span></li>
                <li>Email code: <span className={p.smtpVerified ? 'text-meet-success' : 'text-meet-text-tertiary'}>{p.smtpVerified ? 'verified' : 'not set up'}</span></li>
                <li>LDAP admins: <span className={p.ldapAdminsActive ? 'text-meet-success' : 'text-meet-text-tertiary'}>{p.ldapAdminsActive ? `${p.ldapAdminCount} allowed` : 'off'}</span></li>
              </ul>
            </div>
          </div>

          {/* Local account edits */}
          {p.kind === 'local' && (
            p.passwordManagedByEnv ? (
              <p className="text-sm text-meet-text-tertiary">
                The username and password are set by <code>MEET_ADMIN_USERNAME</code> / <code>MEET_ADMIN_PASSWORD</code> in the environment and cannot be changed here.
              </p>
            ) : (
              <form onSubmit={handleSave} className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-meet-text-tertiary mb-1">Username</label>
                    <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} autoComplete="username" maxLength={100} />
                  </div>
                  <div>
                    <label className="block text-xs text-meet-text-tertiary mb-1">Current password <span className="opacity-60">(required for any change)</span></label>
                    <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={inputClass} autoComplete="current-password" />
                  </div>
                  <div>
                    <label className="block text-xs text-meet-text-tertiary mb-1">New password <span className="opacity-60">(leave blank to keep)</span></label>
                    <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputClass} autoComplete="new-password" minLength={8} />
                  </div>
                  <div>
                    <label className="block text-xs text-meet-text-tertiary mb-1">Confirm new password</label>
                    <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} autoComplete="new-password" />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button type="submit" disabled={saving || !dirty || !currentPassword}
                    className="bg-meet-accent hover:bg-meet-accent-dark disabled:opacity-50 text-meet-bg font-medium px-4 py-2 rounded-xl transition-smooth text-sm">
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  {!p.passwordLoginEnabled && p.localAccountEnabled && (
                    <span className="text-xs text-meet-text-tertiary">Password login is off, but the password is still used to confirm changes here.</span>
                  )}
                </div>
              </form>
            )
          )}

          {p.kind === 'ldap' && (
            <p className="text-sm text-meet-text-tertiary">
              Your name, email and password come from the directory. Admin access was granted by <span className="text-meet-text-secondary">{p.addedBy || 'the local account'}</span>
              {p.createdAt ? ` on ${new Date(p.createdAt).toLocaleDateString()}` : ''}.
              {' '}<button type="button" onClick={logout} className="text-meet-accent hover:underline">Sign out</button>
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default ProfileSection;
