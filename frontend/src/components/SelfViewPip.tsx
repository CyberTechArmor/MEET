import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { LocalParticipant, Track, ParticipantEvent } from 'livekit-client';
import { useRoomStore } from '../stores/roomStore';

interface SelfViewPipProps {
  participant: LocalParticipant;
  isMinimized: boolean;
  onToggleMinimize: () => void;
}

function SelfViewPip({ participant, isMinimized, onToggleMinimize }: SelfViewPipProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { controlsVisible, controlsPinned } = useRoomStore();

  // Determine if we need extra bottom spacing (on mobile when controls are visible)
  const needsExtraSpace = controlsVisible || controlsPinned;

  // Force re-render when tracks change
  const [, setUpdateCounter] = useState(0);
  const forceUpdate = useCallback(() => setUpdateCounter(c => c + 1), []);

  // Subscribe to track events to trigger re-renders
  useEffect(() => {
    const handleTrackChange = () => {
      forceUpdate();
    };

    participant.on(ParticipantEvent.LocalTrackPublished, handleTrackChange);
    participant.on(ParticipantEvent.LocalTrackUnpublished, handleTrackChange);
    participant.on(ParticipantEvent.TrackMuted, handleTrackChange);
    participant.on(ParticipantEvent.TrackUnmuted, handleTrackChange);

    return () => {
      participant.off(ParticipantEvent.LocalTrackPublished, handleTrackChange);
      participant.off(ParticipantEvent.LocalTrackUnpublished, handleTrackChange);
      participant.off(ParticipantEvent.TrackMuted, handleTrackChange);
      participant.off(ParticipantEvent.TrackUnmuted, handleTrackChange);
    };
  }, [participant, forceUpdate]);

  // Get video track (camera)
  const videoPublication = participant.getTrackPublication(Track.Source.Camera);
  const videoTrack = videoPublication?.track;

  // Check if camera is enabled
  const isCameraEnabled = participant.isCameraEnabled;

  // Check if mic is enabled
  const isMicEnabled = participant.isMicrophoneEnabled;

  // Attach video track to element - runs when track or view changes
  useEffect(() => {
    const videoElement = videoRef.current;
    if (videoElement && videoTrack) {
      videoTrack.attach(videoElement);
      return () => {
        videoTrack.detach(videoElement);
      };
    }
  }, [videoTrack, isMinimized, isCameraEnabled]);

  // Generate avatar initials and color
  const initials = useMemo(() => {
    const name = participant.name || participant.identity;
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }, [participant]);

  const avatarColor = useMemo(() => {
    const colors = [
      'bg-blue-500',
      'bg-green-500',
      'bg-purple-500',
      'bg-pink-500',
      'bg-yellow-500',
      'bg-red-500',
      'bg-indigo-500',
      'bg-teal-500',
    ];
    const hash = participant.identity.split('').reduce((a, b) => {
      return a + b.charCodeAt(0);
    }, 0);
    return colors[hash % colors.length];
  }, [participant.identity]);

  // Minimized state - just show a small circular button
  if (isMinimized) {
    return (
      <button
        onClick={onToggleMinimize}
        className={`absolute right-4 z-10 w-14 h-14 rounded-full overflow-hidden shadow-lg border-2 border-meet-accent animate-fade-in hover:scale-110 transition-all duration-300 ${
          needsExtraSpace ? 'bottom-28 sm:bottom-24' : 'bottom-24'
        }`}
        title="Show self view"
      >
        {isCameraEnabled && videoTrack ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover transform scale-x-[-1]"
          />
        ) : (
          <div className={`w-full h-full ${avatarColor} flex items-center justify-center`}>
            <span className="text-white font-semibold text-sm">{initials}</span>
          </div>
        )}
        {/* Expand icon overlay */}
        <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </div>
      </button>
    );
  }

  // Expanded PiP view
  return (
    <div className={`absolute right-4 z-10 w-56 aspect-video rounded-xl overflow-hidden shadow-lg border border-meet-border animate-fade-in group transition-all duration-300 ${
      needsExtraSpace ? 'bottom-28 sm:bottom-24' : 'bottom-24'
    }`}>
      {isCameraEnabled && videoTrack ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover transform scale-x-[-1]"
        />
      ) : (
        <div className="w-full h-full bg-meet-bg-elevated flex items-center justify-center">
          <div className={`${avatarColor} w-16 h-16 rounded-full flex items-center justify-center`}>
            <span className="text-white font-semibold text-lg">{initials}</span>
          </div>
        </div>
      )}

      {/* Overlay with controls */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30 opacity-0 group-hover:opacity-100 transition-opacity">
        {/* Top bar with minimize button */}
        <div className="absolute top-2 right-2">
          <button
            onClick={onToggleMinimize}
            className="p-1.5 rounded-lg bg-black/50 hover:bg-black/70 text-white transition-colors"
            title="Minimize self view"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
        </div>

        {/* Bottom bar with status */}
        <div className="absolute bottom-0 left-0 right-0 p-2">
          <div className="flex items-center justify-between">
            <span className="text-white text-xs font-medium truncate">You</span>
            <div className="flex items-center gap-1">
              {!isMicEnabled && (
                <div className="bg-meet-error/80 rounded-full p-1">
                  <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18" />
                  </svg>
                </div>
              )}
              {!isCameraEnabled && (
                <div className="bg-meet-error/80 rounded-full p-1">
                  <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                  </svg>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Always visible mic muted indicator */}
      {!isMicEnabled && (
        <div className="absolute top-2 left-2 bg-meet-error/80 rounded-full p-1.5 group-hover:opacity-0 transition-opacity">
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18" />
          </svg>
        </div>
      )}
    </div>
  );
}

export default SelfViewPip;
