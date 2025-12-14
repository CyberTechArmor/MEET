import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { ConnectionState, Track, Participant } from 'livekit-client';
import { useRoomStore } from '../stores/roomStore';
import VideoTile from './VideoTile';
import ScreenShareView from './ScreenShareView';
import ControlBar from './ControlBar';
import SelfViewPip from './SelfViewPip';
import { formatRoomCode } from '../lib/livekit';

function VideoRoom() {
  const {
    roomCode,
    connectionState,
    localParticipant,
    remoteParticipants,
    isScreenSharing,
    controlsVisible,
    setControlsVisible,
    controlsPinned,
  } = useRoomStore();

  // PiP self-view state
  const [isPipMinimized, setIsPipMinimized] = useState(false);

  const hideTimeoutRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-hide controls after inactivity (unless pinned)
  const resetHideTimer = useCallback(() => {
    setControlsVisible(true);

    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }

    // Don't auto-hide if controls are pinned
    if (controlsPinned) return;

    hideTimeoutRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, 3000);
  }, [setControlsVisible, controlsPinned]);

  // Show controls on mouse movement
  const handleMouseMove = useCallback(() => {
    resetHideTimer();
  }, [resetHideTimer]);

  // Keep controls visible on hover
  const handleMouseEnter = useCallback(() => {
    setControlsVisible(true);
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
  }, [setControlsVisible]);

  // Start hide timer when mouse leaves (unless pinned)
  const handleMouseLeave = useCallback(() => {
    if (!controlsPinned) {
      resetHideTimer();
    }
  }, [resetHideTimer, controlsPinned]);

  useEffect(() => {
    resetHideTimer();
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, [resetHideTimer]);

  // Find participant who is screen sharing (if any)
  const screenShareParticipant = useMemo((): { participant: Participant; isLocal: boolean } | null => {
    // Check if local participant is sharing
    if (localParticipant) {
      const localScreenShare = localParticipant.getTrackPublication(Track.Source.ScreenShare);
      if (localScreenShare?.track && !localScreenShare.isMuted) {
        return { participant: localParticipant, isLocal: true };
      }
    }

    // Check remote participants
    for (const remote of remoteParticipants) {
      const remoteScreenShare = remote.getTrackPublication(Track.Source.ScreenShare);
      if (remoteScreenShare?.track && !remoteScreenShare.isMuted && remoteScreenShare.isSubscribed) {
        return { participant: remote, isLocal: false };
      }
    }

    return null;
  }, [localParticipant, remoteParticipants, isScreenSharing]);

  // Determine grid layout based on participant count
  const gridClass = useMemo(() => {
    const count = remoteParticipants.length + (remoteParticipants.length === 0 ? 1 : 0); // Count participants in grid
    if (count <= 1) return 'video-grid-1';
    if (count === 2) return 'video-grid-2';
    if (count <= 4) return 'video-grid-4';
    if (count <= 6) return 'video-grid-6';
    return 'video-grid-9'; // 9+ will scroll
  }, [remoteParticipants.length]);

  // Connection states
  if (connectionState === ConnectionState.Connecting) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-meet-bg">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-meet-accent border-t-transparent mb-4" />
        <p className="text-meet-text-secondary text-lg">Connecting to room...</p>
      </div>
    );
  }

  if (connectionState === ConnectionState.Reconnecting) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-meet-bg">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-meet-warning border-t-transparent mb-4" />
        <p className="text-meet-text-secondary text-lg">Reconnecting...</p>
        <p className="text-meet-text-tertiary text-sm mt-2">Please wait</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-meet-bg relative overflow-hidden"
      onMouseMove={handleMouseMove}
    >
      {/* Room Code Badge */}
      <div
        className={`absolute top-4 left-4 z-20 transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="glass rounded-lg px-4 py-2 flex items-center gap-2">
          <span className="text-meet-text-tertiary text-sm">Room:</span>
          <span className="text-meet-text-primary font-mono font-semibold">
            {formatRoomCode(roomCode)}
          </span>
          <button
            onClick={() => navigator.clipboard.writeText(roomCode)}
            className="text-meet-text-tertiary hover:text-meet-accent transition-smooth ml-1"
            title="Copy room code"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Screen Share Indicator */}
      {screenShareParticipant && (
        <div className="absolute top-4 right-4 z-20">
          <div className="bg-meet-success/20 border border-meet-success/50 rounded-lg px-4 py-2 flex items-center gap-2 pulse-glow">
            <div className="w-2 h-2 rounded-full bg-meet-success animate-pulse" />
            <span className="text-meet-success text-sm font-medium">
              {screenShareParticipant.isLocal
                ? 'Sharing your screen'
                : `${screenShareParticipant.participant.name || screenShareParticipant.participant.identity} is sharing`}
            </span>
          </div>
        </div>
      )}

      {/* Waiting for others */}
      {remoteParticipants.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center">
            <div className="glass rounded-2xl px-8 py-6 animate-fade-in">
              <p className="text-meet-text-secondary text-lg mb-2">
                Waiting for others to join...
              </p>
              <p className="text-meet-text-tertiary text-sm">
                Share the room code:{' '}
                <span className="font-mono font-semibold text-meet-accent">
                  {formatRoomCode(roomCode)}
                </span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Screen Share Layout or Regular Video Grid */}
      {screenShareParticipant ? (
        // Screen share layout - main screen share with participant strip
        <div className="h-full flex flex-col">
          {/* Main screen share area */}
          <div className="flex-1 p-4 pb-2">
            <ScreenShareView
              participant={screenShareParticipant.participant}
              isLocal={screenShareParticipant.isLocal}
            />
          </div>

          {/* Participant strip at bottom */}
          <div className="h-32 px-4 pb-4 flex gap-2 overflow-x-auto">
            {/* Local participant */}
            {localParticipant && (
              <div className="h-full aspect-video flex-shrink-0 rounded-xl overflow-hidden">
                <VideoTile
                  participant={localParticipant}
                  isLocal={true}
                  isSmall={true}
                />
              </div>
            )}
            {/* Remote participants */}
            {remoteParticipants.map((participant) => (
              <div key={participant.identity} className="h-full aspect-video flex-shrink-0 rounded-xl overflow-hidden">
                <VideoTile
                  participant={participant}
                  isLocal={false}
                  isSmall={true}
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        // Regular video grid
        <>
          <div className={`video-grid ${gridClass} h-full`}>
            {/* Remote participants */}
            {remoteParticipants.map((participant) => (
              <VideoTile
                key={participant.identity}
                participant={participant}
                isLocal={false}
              />
            ))}

            {/* Local participant in main grid if alone */}
            {localParticipant && remoteParticipants.length === 0 && (
              <VideoTile
                participant={localParticipant}
                isLocal={true}
                isSmall={false}
              />
            )}
          </div>

          {/* PiP Self View - shown when there are remote participants and no screen share */}
          {localParticipant && remoteParticipants.length > 0 && (
            <SelfViewPip
              participant={localParticipant}
              isMinimized={isPipMinimized}
              onToggleMinimize={() => setIsPipMinimized(!isPipMinimized)}
            />
          )}
        </>
      )}

      {/* Control Bar */}
      <div
        className={`controls-container ${!controlsVisible ? 'controls-hidden' : ''}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <ControlBar />
      </div>
    </div>
  );
}

export default VideoRoom;
