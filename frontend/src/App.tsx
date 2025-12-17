import { useEffect, useRef } from 'react';
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

function App() {
  const view = useRoomStore((state) => state.view);
  const { setDisplayName, setRoomCode } = useRoomStore();
  const { connect } = useLiveKit();
  const hasAttemptedRejoin = useRef(false);

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
    </div>
  );
}

export default App;
