import { useEffect, useRef, useState } from 'react';
import { ConnectionState, DisconnectReason } from 'livekit-client';
import { useRoomStore } from './stores/roomStore';
import { useLiveKit } from './hooks/useLiveKit';
import {
  getSavedSession,
  clearSession,
  parseJoinLink,
  clearJoinLinkParams,
  setVideoQualityPreset,
  getPublicStatus,
  checkParticipantSession,
  ldapParticipantLogout,
  getRememberedDisplayName,
  generateGuestName,
  type ParticipantSession,
} from './lib/livekit';
import JoinForm from './components/JoinForm';
import LdapLoginForm from './components/LdapLoginForm';
import VideoRoom from './components/VideoRoom';
import AdminPanel from './components/AdminPanel';

const MAX_AUTO_REJOIN_ATTEMPTS = 12;

// Disconnect reasons worth retrying without asking. Everything else means
// the user, the host, or the server ended it on purpose.
function isTransientDisconnect(reason: number): boolean {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
    case DisconnectReason.DUPLICATE_IDENTITY:
    case DisconnectReason.PARTICIPANT_REMOVED:
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
    case DisconnectReason.USER_REJECTED:
    case DisconnectReason.USER_UNAVAILABLE:
      return false;
    default:
      return true;
  }
}

function App() {
  const view = useRoomStore((state) => state.view);
  const embedMode = useRoomStore((state) => state.embedMode);
  const embedRoomCode = useRoomStore((state) => state.embedRoomCode);
  const embedAutoJoin = useRoomStore((state) => state.embedAutoJoin);
  const connectionState = useRoomStore((state) => state.connectionState);
  const lastDisconnectReason = useRoomStore((state) => state.lastDisconnectReason);
  const { setDisplayName, setRoomCode, setHideEndCall, setEmbed, setEmbedAutoJoin, setEmbedJoining } = useRoomStore();
  const { connect } = useLiveKit();
  const hasAttemptedRejoin = useRef(false);
  // Hash-driven so a refresh while the admin panel is open lands back in
  // the same panel + tab instead of bouncing to the join screen.
  // #admin              → dashboard
  // #admin/settings     → settings tab (etc.)
  const [showAdmin, setShowAdmin] = useState(
    () => typeof window !== 'undefined' && window.location.hash.startsWith('#admin')
  );
  const [publicAccessEnabled, setPublicAccessEnabled] = useState<boolean | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  // Directory-gated frontend: when the server says ldapRequired, the
  // participant must sign in against LDAP before the join screen shows.
  const [ldapRequired, setLdapRequired] = useState(false);
  const [participant, setParticipant] = useState<ParticipantSession | null>(null);

  // Mirror showAdmin into the URL hash, and react to back/forward.
  useEffect(() => {
    const hashIsAdmin = window.location.hash.startsWith('#admin');
    if (showAdmin && !hashIsAdmin) {
      window.history.replaceState(null, '', '#admin');
    } else if (!showAdmin && hashIsAdmin) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, [showAdmin]);

  useEffect(() => {
    const onHashChange = () => {
      setShowAdmin(window.location.hash.startsWith('#admin'));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Check public access status on mount
  useEffect(() => {
    getPublicStatus()
      .then(async (status) => {
        setPublicAccessEnabled(status.publicAccessEnabled);
        if (status.ldapRequired) {
          setLdapRequired(true);
          const session = await checkParticipantSession();
          setParticipant(session);
          if (session && !useRoomStore.getState().displayName) {
            setDisplayName(session.displayName || session.username);
          }
        }
      })
      .catch(() => {
        // If we can't reach the API, assume public access is enabled
        setPublicAccessEnabled(true);
      })
      .finally(() => {
        setIsCheckingStatus(false);
      });
  }, [setDisplayName]);

  // A 401 from /api/token means the participant session is gone.
  useEffect(() => {
    const onUnauthorized = () => {
      if (ldapRequired && !window.location.hash.startsWith('#admin')) {
        setParticipant(null);
      }
    };
    window.addEventListener('admin:unauthorized', onUnauthorized);
    return () => window.removeEventListener('admin:unauthorized', onUnauthorized);
  }, [ldapRequired]);

  // Handle join links and auto-rejoin on page load
  useEffect(() => {
    if (hasAttemptedRejoin.current) return;
    hasAttemptedRejoin.current = true;

    // First, check for join link parameters in URL
    const joinParams = parseJoinLink();

    if (joinParams.room) {
      console.log('Found join link parameters:', joinParams);

      // Set quality preset if specified
      if (joinParams.quality) {
        setVideoQualityPreset(joinParams.quality);
      }

      // Set hideEndCall for iframe embeds
      if (joinParams.hideEndCall) {
        setHideEndCall(true);
      }

      // Pre-fill the form fields
      setRoomCode(joinParams.room);
      if (joinParams.name) {
        setDisplayName(joinParams.name);
      }

      // Embed mode (API-created meeting / iframe): remember the room so the
      // SPA never shows the create/join configuration screen. Joining is
      // handled by the auto-join effect below (name from the link, the
      // session saved before a reload, the last name used in this browser,
      // or a guest name) unless the link says autojoin=false.
      if (joinParams.embed) {
        setEmbed(true, joinParams.room);
        setEmbedAutoJoin(joinParams.autojoinExplicit ? joinParams.autojoin : true);
        if (!joinParams.name) {
          const saved = getSavedSession();
          if (saved && saved.roomCode === joinParams.room && saved.displayName) {
            setDisplayName(saved.displayName);
          }
        }
        clearJoinLinkParams();
        return;
      }

      // Auto-join if both room and name are provided and autojoin is true
      if (joinParams.name && joinParams.autojoin) {
        console.log('Auto-joining meeting:', joinParams.room, 'as', joinParams.name);
        clearJoinLinkParams(); // Clean up URL before connecting
        connect(joinParams.room, joinParams.name).catch((error) => {
          console.error('Failed to auto-join from link:', error);
        });
        return;
      }

      // Clean up URL params (keep form pre-filled but clean URL)
      clearJoinLinkParams();
      return;
    }

    // No join link, check for saved session (page refresh rejoin)
    const session = getSavedSession();
    if (session) {
      console.log('Found saved session, attempting to rejoin:', session.roomCode);
      connect(session.roomCode, session.displayName).catch((error) => {
        console.error('Failed to rejoin session:', error);
        clearSession();
      });
    }
  }, [connect, setDisplayName, setRoomCode, setHideEndCall, setEmbed, setEmbedAutoJoin]);

  // Embed mode: connect on our own, and reconnect after a disconnect the
  // user didn't ask for. LiveKit already retries transient signal drops
  // internally; this covers the cases where it gives up (or the host page
  // reloaded the iframe) so the call comes back without anyone clicking.
  // Backoff: immediate, then 1.5s, 3s, 6s, 12s, 15s … up to MAX attempts.
  // Non-transient reasons (user left, meeting ended, removed, opened in
  // another window) fall through to the prompt in JoinForm.
  const rejoinAttempts = useRef(0);
  useEffect(() => {
    if (!embedMode || !embedRoomCode || !embedAutoJoin) return;
    if (view !== 'join') {
      rejoinAttempts.current = 0;
      return;
    }
    if (connectionState === ConnectionState.Connecting) return;
    if (ldapRequired && !participant) {
      setEmbedJoining(false);
      return;
    }
    const reason = lastDisconnectReason;
    if (reason !== null && !isTransientDisconnect(reason)) {
      setEmbedJoining(false);
      return;
    }
    const attempt = rejoinAttempts.current;
    if (attempt >= MAX_AUTO_REJOIN_ATTEMPTS) {
      setEmbedJoining(false);
      return;
    }
    const delay = attempt === 0 ? 0 : Math.min(15000, 1500 * 2 ** (attempt - 1));
    setEmbedJoining(true);
    const timer = setTimeout(() => {
      rejoinAttempts.current += 1;
      const name = (useRoomStore.getState().displayName || getRememberedDisplayName() || generateGuestName()).trim().slice(0, 50);
      setDisplayName(name);
      console.log(`Embed auto-join (attempt ${rejoinAttempts.current}):`, embedRoomCode, 'as', name);
      connect(embedRoomCode, name, { silent: true }).catch((error) => {
        // connectionState flips back to Disconnected and this effect
        // re-runs with backoff.
        console.error('Embed auto-join failed:', error);
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [embedMode, embedRoomCode, embedAutoJoin, view, connectionState, lastDisconnectReason, ldapRequired, participant, connect, setDisplayName, setEmbedJoining]);


  // Show loading state while checking status
  if (isCheckingStatus) {
    return (
      <div className="h-full w-full bg-meet-bg flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-meet-accent border-t-transparent rounded-full"></div>
      </div>
    );
  }

  // Show disabled message when public access is off
  if (publicAccessEnabled === false && view === 'join') {
    return (
      <div className="h-full w-full bg-meet-bg flex flex-col items-center justify-center p-8">
        <div className="text-center max-w-md">
          {/* MEET Logo/Title */}
          <h1 className="text-5xl font-bold text-meet-text-primary mb-4">MEET</h1>

          {/* Disabled icon */}
          <div className="mb-6 flex justify-center">
            <div className="w-20 h-20 rounded-full bg-meet-error/20 flex items-center justify-center">
              <svg className="w-10 h-10 text-meet-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </div>
          </div>

          {/* Message */}
          <h2 className="text-2xl font-semibold text-meet-text-primary mb-3">
            Public Access Disabled
          </h2>
          <p className="text-meet-text-secondary mb-6">
            The public video conferencing service is currently unavailable.
            Please contact an administrator if you need access.
          </p>

          {/* Info box */}
          <div className="glass rounded-xl p-4 text-left">
            <p className="text-sm text-meet-text-tertiary">
              <strong className="text-meet-text-secondary">For integrations:</strong> API access with valid API keys is still available.
              Contact your administrator for API credentials.
            </p>
          </div>
        </div>

        {/* Admin Button - always accessible */}
        <button
          onClick={() => setShowAdmin(true)}
          className="fixed bottom-4 right-4 p-2 text-meet-text-tertiary hover:text-meet-text-secondary transition-smooth opacity-50 hover:opacity-100"
          title="Admin Panel"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {/* Admin Panel */}
        {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
      </div>
    );
  }

  // Directory sign-in gate (participants only; the admin panel has its own).
  if (ldapRequired && !participant && view === 'join' && !showAdmin) {
    return (
      <div className="h-full w-full bg-meet-bg">
        <LdapLoginForm
          onSignedIn={(session) => {
            setParticipant(session);
            if (!useRoomStore.getState().displayName) {
              setDisplayName(session.displayName || session.username);
            }
          }}
        />
        {!embedMode && (
          <button
            onClick={() => setShowAdmin(true)}
            className="fixed bottom-4 right-4 p-2 text-meet-text-tertiary hover:text-meet-text-secondary transition-smooth opacity-50 hover:opacity-100"
            title="Admin Panel"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-meet-bg">
      {view === 'join' ? <JoinForm /> : <VideoRoom />}

      {/* Signed-in participant (directory-gated frontend) */}
      {ldapRequired && participant && view === 'join' && (
        <div className="fixed bottom-4 left-4 text-xs text-meet-text-tertiary flex items-center gap-2">
          <span>Signed in as {participant.displayName || participant.username}</span>
          <button
            onClick={() => { ldapParticipantLogout(); setParticipant(null); }}
            className="text-meet-accent hover:text-meet-accent-light"
          >
            Sign out
          </button>
        </div>
      )}

      {/* Admin Button - only shown on join screen, never in embed mode */}
      {view === 'join' && !embedMode && (
        <button
          onClick={() => setShowAdmin(true)}
          className="fixed bottom-4 right-4 p-2 text-meet-text-tertiary hover:text-meet-text-secondary transition-smooth opacity-50 hover:opacity-100"
          title="Admin Panel"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      )}

      {/* Admin Panel */}
      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
    </div>
  );
}

export default App;
