import { useCallback, useEffect, useRef, useState, FormEvent } from 'react';
import {
  getNodusSettings,
  updateNodusSettings,
  deleteNodusSettings,
  listApiKeys,
  type ApiKeyInfo,
  type NodusStatus,
} from '../lib/livekit';

interface Props {
  token: string;
  /** The admin panel's key list; when it changes (created, rotated, revoked) both are read again here. */
  apiKeys: ApiKeyInfo[];
}

const inputClass =
  'w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-2 text-sm text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none';

const canActForNodus = (key: ApiKeyInfo) => key.permissions.includes('write') || key.permissions.includes('admin');

/**
 * Nodus calls: which API key acts for Nodus and the Nodus address MEET checks
 * each private join with. Saved here it applies at once, so the key can be
 * replaced without touching the server. A key presented to MEET can never
 * select itself; only an administrator chooses it here.
 */
function NodusSettingsSection({ token, apiKeys }: Props) {
  const [status, setStatus] = useState<NodusStatus | null>(null);
  // Read here as well, so this section does not depend on the dashboard's room list loading.
  const [keys, setKeys] = useState<ApiKeyInfo[]>(apiKeys);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [keyId, setKeyId] = useState('');
  const [nodusOrigin, setNodusOrigin] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Unsaved edits survive a background reload of the status.
  const dirty = useRef(false);

  const apply = useCallback((s: NodusStatus, fields: boolean) => {
    setStatus(s);
    if (fields) {
      setKeyId(s.keyId ?? '');
      setNodusOrigin(s.nodusOrigin ?? '');
      dirty.current = false;
    }
  }, []);

  const keySignature = apiKeys.map((k) => `${k.id}:${k.permissions.join('+')}`).join(',');
  useEffect(() => {
    let cancelled = false;
    Promise.all([getNodusSettings(token), listApiKeys(token)])
      .then(([s, list]) => { if (!cancelled) { setKeys(list.apiKeys); apply(s, !dirty.current); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load the Nodus connection'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, keySignature, apply]);

  const edit = (setter: (v: string) => void) => (v: string) => { setter(v); dirty.current = true; setNotice(''); };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setSaving(true);
    try {
      const s = await updateNodusSettings(token, { keyId, nodusOrigin });
      apply(s, true);
      setNotice(s.configured
        ? 'Saved. It applies now; in Nodus Settings → MEET calls, choose Check again.'
        : 'Saved, but private calls cannot run yet; see the message above.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the Nodus connection');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setError('');
    setNotice('');
    try {
      const s = await deleteNodusSettings(token);
      apply(s, true);
      setConfirmRemove(false);
      setNotice(s.source === 'environment'
        ? 'Removed. The values set on the server apply again.'
        : 'Removed. Private Nodus calls are off.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove the Nodus connection');
    }
  };

  const eligible = keys.filter(canActForNodus);
  // The server says whether the saved key still exists (keyName); a key it cannot find is shown as missing.
  const savedName = keyId && keyId === status?.keyId ? status.keyName : null;
  const unlisted = !!keyId && !eligible.some((k) => k.id === keyId);
  const selectedMissing = unlisted && !savedName;
  const configured = !!status?.configured;

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <h3 className="text-lg font-semibold text-meet-text-primary">Nodus calls</h3>
          <p className="text-sm text-meet-text-secondary mt-1">
            Lets Nodus hold private calls in MEET. Choose the API key you entered in Nodus and the Nodus address.
            Changes apply at once; no server restart is needed.
          </p>
        </div>
        <span
          className={`shrink-0 text-xs font-medium px-2 py-1 rounded-full border ${
            configured
              ? 'text-meet-success border-meet-success/40 bg-meet-success/10'
              : status?.problem
                ? 'text-yellow-500 border-yellow-500/40 bg-yellow-500/10'
                : 'text-meet-text-tertiary border-meet-border'
          }`}
        >
          {configured ? 'On' : status?.problem ? 'Needs attention' : 'Off'}
        </span>
      </div>

      {status?.problem && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-4 py-2 text-yellow-500 text-sm mb-3" role="status">
          {status.problem}
        </div>
      )}
      {status?.source === 'environment' && (
        <p className="text-sm text-meet-text-tertiary mb-3">
          These values are currently set on the server (nodus.env). Saving here replaces them.
        </p>
      )}
      {error && (
        <div className="bg-meet-error/10 border border-meet-error/30 rounded-lg px-4 py-2 text-meet-error text-sm mb-3" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="bg-meet-accent/10 border border-meet-accent/30 rounded-lg px-4 py-2 text-meet-accent text-sm mb-3" role="status">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-24">
          <div className="animate-spin h-6 w-6 border-4 border-meet-accent border-t-transparent rounded-full"></div>
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor="nodus-key" className="block text-xs text-meet-text-tertiary mb-1">API key used by Nodus</label>
              <select id="nodus-key" value={keyId} onChange={(e) => edit(setKeyId)(e.target.value)} className={inputClass}>
                <option value="" disabled>{eligible.length ? 'Choose a key with write access' : 'Create a key with write access above'}</option>
                {unlisted && <option value={keyId}>{savedName ?? `Missing key (${keyId})`}</option>}
                {eligible.map((k) => (
                  <option key={k.id} value={k.id}>{k.name} ({k.keyPrefix})</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="nodus-origin" className="block text-xs text-meet-text-tertiary mb-1">Nodus address</label>
              <input id="nodus-origin" type="url" inputMode="url" value={nodusOrigin}
                onChange={(e) => edit(setNodusOrigin)(e.target.value)}
                placeholder="https://nodus.example.com" className={inputClass} autoComplete="off" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="submit" disabled={saving || !keyId || selectedMissing || !nodusOrigin.trim()}
              className="bg-meet-accent hover:bg-meet-accent-dark disabled:opacity-50 text-meet-bg font-medium px-4 py-2 rounded-xl transition-smooth text-sm">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {status?.source === 'settings' && (
              confirmRemove ? (
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-meet-text-secondary">
                    {status.environmentSet ? 'Remove? The values set on the server apply again.' : 'Remove? Private Nodus calls turn off.'}
                  </span>
                  <button type="button" onClick={handleRemove} className="text-meet-error hover:underline">Yes, remove</button>
                  <button type="button" onClick={() => setConfirmRemove(false)} className="text-meet-text-tertiary hover:underline">Cancel</button>
                </span>
              ) : (
                <button type="button" onClick={() => setConfirmRemove(true)} className="text-meet-error hover:underline text-sm px-2">
                  Remove
                </button>
              )
            )}
          </div>

          <p className="text-xs text-meet-text-tertiary">
            To rotate the key, use Rotate on it above and enter the new value in Nodus Settings → MEET calls → Replace API key;
            nothing changes here. To use a different key, create it above with write access, choose it here and save, then
            enter it in Nodus and save there.
          </p>
          {status?.source === 'settings' && status.updatedAt && (
            <p className="text-xs text-meet-text-tertiary">
              Saved {new Date(status.updatedAt).toLocaleString()}{status.updatedBy ? ` by ${status.updatedBy}` : ''}.
            </p>
          )}
        </form>
      )}
    </div>
  );
}

export default NodusSettingsSection;
