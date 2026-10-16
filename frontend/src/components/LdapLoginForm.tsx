import { useState, FormEvent } from 'react';
import { ldapParticipantLogin, type ParticipantSession } from '../lib/livekit';

interface Props {
  onSignedIn: (session: ParticipantSession) => void;
}

/**
 * Shown before the join screen when the server requires a directory
 * (LDAP) sign-in for the meeting frontend.
 */
function LdapLoginForm({ onSignedIn }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onSignedIn(await ldapParticipantLogin(username.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex flex-col items-center justify-center p-6">
      <div className="mb-8 text-center">
        <h1 className="font-display text-5xl font-bold text-meet-text-primary mb-2 tracking-tight">MEET</h1>
        <p className="text-meet-text-secondary text-lg">Sign in with your directory account</p>
      </div>
      <form onSubmit={handleSubmit} className="glass rounded-2xl p-8 w-full max-w-md shadow-soft animate-fade-in space-y-4">
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username or email"
          autoComplete="username"
          autoFocus
          className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
        />
        {error && (
          <div className="bg-meet-error/10 border border-meet-error/30 rounded-lg px-4 py-2 text-meet-error text-sm">{error}</div>
        )}
        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="w-full bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-semibold py-3 px-6 rounded-xl transition-smooth disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="mt-8 text-center text-meet-text-tertiary text-sm">
        <p>This server requires a directory account to join meetings.</p>
      </div>
    </div>
  );
}

export default LdapLoginForm;
