import { useCallback, useEffect, useState, FormEvent } from 'react';
import {
  getSmtpSettings,
  updateSmtpSettings,
  deleteSmtpSettings,
  sendSmtpTest,
  verifySmtpTest,
  type SmtpStatus,
} from '../lib/livekit';

interface Props {
  token: string;
  /** Number of registered passkeys — used for the "no backup" warning. */
  passkeyCount: number;
}

const inputClass =
  'w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-2 text-sm text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none';

/**
 * Email sign-in (SMTP) configuration.
 *
 * Flow: fill in the server + addresses → Save → "Send test code" → type the
 * code from the inbox → verified. Verification is the switch that turns
 * password login off, so a broken mail server can never lock the admin
 * out: until a code has actually round-tripped, the password keeps working.
 */
function SmtpSettingsSection({ token, passkeyCount }: Props) {
  const [status, setStatus] = useState<SmtpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Form fields (strings so the inputs stay controlled).
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Test-code round trip.
  const [testTicket, setTestTicket] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [testCode, setTestCode] = useState('');
  const [testBusy, setTestBusy] = useState(false);

  const [confirmRemove, setConfirmRemove] = useState(false);

  const applyStatus = useCallback((s: SmtpStatus) => {
    setStatus(s);
    if (s.settings) {
      setHost(s.settings.host);
      setPort(String(s.settings.port));
      setSecure(s.settings.secure);
      setUsername(s.settings.username);
      setFromAddress(s.settings.fromAddress);
      setAdminEmail(s.settings.adminEmail);
    }
    setPassword('');
    setDirty(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSmtpSettings(token)
      .then((s) => { if (!cancelled) applyStatus(s); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load SMTP settings'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, applyStatus]);

  const mark = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setDirty(true); };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setSaving(true);
    try {
      const s = await updateSmtpSettings(token, {
        host,
        port: Number(port),
        secure,
        username,
        ...(password ? { password } : {}),
        fromAddress,
        adminEmail,
      });
      applyStatus(s);
      setTestTicket(null);
      setNotice(s.verified
        ? 'Saved.'
        : 'Saved. Send a test code and confirm it to switch password login off.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save SMTP settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSendTest = async () => {
    setError('');
    setNotice('');
    setTestBusy(true);
    try {
      const r = await sendSmtpTest(token);
      setTestTicket(r.ticket);
      setTestEmail(r.email);
      setTestCode('');
      setNotice(`Test code sent to ${r.email}. Enter it below.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send test email');
    } finally {
      setTestBusy(false);
    }
  };

  const handleVerifyTest = async (e: FormEvent) => {
    e.preventDefault();
    if (!testTicket) return;
    setError('');
    setNotice('');
    setTestBusy(true);
    try {
      const s = await verifySmtpTest(token, testTicket, testCode);
      applyStatus(s);
      setTestTicket(null);
      setTestCode('');
      setNotice('Email sign-in verified. Password login is now disabled.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Incorrect code');
    } finally {
      setTestBusy(false);
    }
  };

  const handleRemove = async () => {
    setError('');
    setNotice('');
    try {
      const s = await deleteSmtpSettings(token);
      setStatus(s);
      setHost(''); setPort('587'); setSecure(false); setUsername('');
      setPassword(''); setFromAddress(''); setAdminEmail('');
      setDirty(false);
      setTestTicket(null);
      setConfirmRemove(false);
      setNotice('SMTP settings removed. Password login is enabled again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove SMTP settings');
    }
  };

  const verified = !!status?.verified;
  const configured = !!status?.configured;

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h3 className="text-lg font-semibold text-meet-text-primary">Email sign-in (SMTP)</h3>
          <p className="text-sm text-meet-text-secondary mt-1">
            Sign in with a one-time code emailed to you. Once a test code has been confirmed,
            <strong className="text-meet-text-primary"> password login is turned off</strong> and the
            admin account signs in with a passkey or an emailed code only.
          </p>
        </div>
        <span
          className={`shrink-0 text-xs font-medium px-2 py-1 rounded-full border ${
            verified
              ? 'text-meet-success border-meet-success/40 bg-meet-success/10'
              : configured
                ? 'text-yellow-500 border-yellow-500/40 bg-yellow-500/10'
                : 'text-meet-text-tertiary border-meet-border'
          }`}
        >
          {verified ? 'Verified · password login off' : configured ? 'Saved · not verified' : 'Not configured'}
        </span>
      </div>

      {verified && passkeyCount === 0 && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-4 py-2 text-yellow-500 text-sm mb-3">
          No passkey is registered. If this mail server ever stops delivering you will need
          <code className="mx-1">reset-admin.js --clear-smtp</code> from the server to get back in.
          Register a passkey above as a backup.
        </div>
      )}

      {error && (
        <div className="bg-meet-error/10 border border-meet-error/30 rounded-lg px-4 py-2 text-meet-error text-sm mb-3">
          {error}
        </div>
      )}
      {notice && (
        <div className="bg-meet-accent/10 border border-meet-accent/30 rounded-lg px-4 py-2 text-meet-accent text-sm mb-3">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-24">
          <div className="animate-spin h-6 w-6 border-4 border-meet-accent border-t-transparent rounded-full"></div>
        </div>
      ) : (
        <>
          <form onSubmit={handleSave} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs text-meet-text-tertiary mb-1">SMTP host</label>
                <input type="text" value={host} onChange={(e) => mark(setHost)(e.target.value)}
                  placeholder="smtp.example.com" className={inputClass} autoComplete="off" />
              </div>
              <div>
                <label className="block text-xs text-meet-text-tertiary mb-1">Port</label>
                <input type="number" min={1} max={65535} value={port}
                  onChange={(e) => mark(setPort)(e.target.value)} className={inputClass} />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-meet-text-secondary">
              <input type="checkbox" checked={secure} onChange={(e) => mark(setSecure)(e.target.checked)}
                className="accent-meet-accent" />
              Implicit TLS (port 465). Leave off for STARTTLS on 587 or plain 25.
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-meet-text-tertiary mb-1">Username <span className="opacity-60">(optional)</span></label>
                <input type="text" value={username} onChange={(e) => mark(setUsername)(e.target.value)}
                  className={inputClass} autoComplete="off" />
              </div>
              <div>
                <label className="block text-xs text-meet-text-tertiary mb-1">Password <span className="opacity-60">(optional)</span></label>
                <input type="password" value={password} onChange={(e) => mark(setPassword)(e.target.value)}
                  placeholder={status?.settings?.hasPassword ? '•••••••• (unchanged)' : ''}
                  className={inputClass} autoComplete="new-password" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-meet-text-tertiary mb-1">From address</label>
                <input type="email" value={fromAddress} onChange={(e) => mark(setFromAddress)(e.target.value)}
                  placeholder="meet@example.com" className={inputClass} autoComplete="off" />
              </div>
              <div>
                <label className="block text-xs text-meet-text-tertiary mb-1">Send sign-in codes to</label>
                <input type="email" value={adminEmail} onChange={(e) => mark(setAdminEmail)(e.target.value)}
                  placeholder="you@example.com" className={inputClass} autoComplete="off" />
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <button type="submit" disabled={saving || !host || !fromAddress || !adminEmail}
                className="bg-meet-accent hover:bg-meet-accent-dark disabled:opacity-50 text-meet-bg font-medium px-4 py-2 rounded-xl transition-smooth text-sm">
                {saving ? 'Saving…' : dirty ? 'Save settings' : 'Saved'}
              </button>
              <button type="button" onClick={handleSendTest} disabled={testBusy || !configured || dirty}
                title={dirty ? 'Save first' : !configured ? 'Save the settings first' : ''}
                className="bg-meet-bg-tertiary hover:bg-meet-bg-elevated border border-meet-border disabled:opacity-50 text-meet-text-primary font-medium px-4 py-2 rounded-xl transition-smooth text-sm">
                {testBusy && !testTicket ? 'Sending…' : verified ? 'Send another test code' : 'Send test code'}
              </button>
              {status?.settings && (
                confirmRemove ? (
                  <span className="flex items-center gap-2 text-sm">
                    <span className="text-meet-text-secondary">Remove and re-enable password login?</span>
                    <button type="button" onClick={handleRemove} className="text-meet-error hover:underline">Yes, remove</button>
                    <button type="button" onClick={() => setConfirmRemove(false)} className="text-meet-text-tertiary hover:underline">Cancel</button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirmRemove(true)}
                    className="text-meet-error hover:underline text-sm px-2">
                    Remove
                  </button>
                )
              )}
            </div>
          </form>

          {testTicket && (
            <form onSubmit={handleVerifyTest} className="mt-4 bg-meet-bg-tertiary border border-meet-border rounded-xl p-4">
              <p className="text-sm text-meet-text-secondary mb-2">
                Enter the 6-digit code we sent to <span className="text-meet-text-primary">{testEmail}</span>.
                Confirming it turns password login off.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={testCode}
                  onChange={(e) => setTestCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  className={`${inputClass} font-mono tracking-widest text-center max-w-[10rem]`}
                  autoFocus
                />
                <button type="submit" disabled={testBusy || testCode.length !== 6}
                  className="bg-meet-accent hover:bg-meet-accent-dark disabled:opacity-50 text-meet-bg font-medium px-4 py-2 rounded-xl transition-smooth text-sm">
                  {testBusy ? 'Checking…' : 'Confirm'}
                </button>
                <button type="button" onClick={() => setTestTicket(null)}
                  className="text-meet-text-tertiary hover:text-meet-text-secondary text-sm px-2">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {verified && status?.settings?.verifiedAt && (
            <p className="text-xs text-meet-text-tertiary mt-3">
              Verified {new Date(status.settings.verifiedAt).toLocaleString()}. Editing any field above un-verifies the
              configuration and password login comes back until a new test code is confirmed.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default SmtpSettingsSection;
