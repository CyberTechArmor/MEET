import { useEffect, useRef } from 'react';
import { useRoomStore } from './stores/roomStore';
import { useLiveKit } from './hooks/useLiveKit';
import { getSavedSession, clearSession } from './lib/livekit';
import JoinForm from './components/JoinForm';
import VideoRoom from './components/VideoRoom';

function App() {
  const view = useRoomStore((state) => state.view);
  const { connect } = useLiveKit();
  const hasAttemptedRejoin = useRef(false);

  // Auto-rejoin on page refresh if there's a saved session
  useEffect(() => {
    if (hasAttemptedRejoin.current) return;
    hasAttemptedRejoin.current = true;

    const session = getSavedSession();
    if (session) {
      console.log('Found saved session, attempting to rejoin:', session.roomCode);
      connect(session.roomCode, session.displayName).catch((error) => {
        console.error('Failed to rejoin session:', error);
        clearSession();
      });
    }
  }, [connect]);

  return (
    <div className="h-full w-full bg-meet-bg">
      {view === 'join' ? <JoinForm /> : <VideoRoom />}
    </div>
  );
}

export default App;
