import { useEffect, useRef, useState } from 'react';
import { useRoomStore } from './stores/roomStore';
import { useLiveKit } from './hooks/useLiveKit';
import {
  getSavedSession,
  clearSession,
  parseJoinLink,
  clearJoinLinkParams,
  setVideoQualityPreset,
} from './lib/livekit';
import JoinForm from './components/JoinForm';
import VideoRoom from './components/VideoRoom';
import AdminPanel from './components/AdminPanel';

function App() {
  const view = useRoomStore((state) => state.view);
  const { setDisplayName, setRoomCode } = useRoomStore();
  const { connect } = useLiveKit();
  const hasAttemptedRejoin = useRef(false);
  const [showAdmin, setShowAdmin] = useState(false);

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

      // Pre-fill the form fields
      setRoomCode(joinParams.room);
      if (joinParams.name) {
        setDisplayName(joinParams.name);
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
  }, [connect, setDisplayName, setRoomCode]);


  return (
    <div className="h-full w-full bg-meet-bg">
      {view === 'join' ? <JoinForm /> : <VideoRoom />}

      {/* Admin Button - only shown on join screen */}
      {view === 'join' && (
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
