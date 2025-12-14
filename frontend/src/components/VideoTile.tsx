import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Participant, Track, ParticipantEvent, LocalParticipant } from 'livekit-client';
import ParticipantOverlay from './ParticipantOverlay';

interface VideoTileProps {
  participant: Participant;
  isLocal: boolean;
  isSmall?: boolean;
}

function VideoTile({ participant, isLocal, isSmall = false }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenShareRef = useRef<HTMLVideoElement>(null);

  // Force re-render when tracks change
  const [, setUpdateCounter] = useState(0);
  const forceUpdate = useCallback(() => setUpdateCounter(c => c + 1), []);

  // Subscribe to track events to trigger re-renders
  useEffect(() => {
    const handleTrackChange = () => {
      forceUpdate();
    };

    participant.on(ParticipantEvent.TrackSubscribed, handleTrackChange);
    participant.on(ParticipantEvent.TrackUnsubscribed, handleTrackChange);
    participant.on(ParticipantEvent.TrackMuted, handleTrackChange);
    participant.on(ParticipantEvent.TrackUnmuted, handleTrackChange);
    participant.on(ParticipantEvent.TrackPublished, handleTrackChange);
    participant.on(ParticipantEvent.TrackUnpublished, handleTrackChange);
    participant.on(ParticipantEvent.LocalTrackPublished, handleTrackChange);
    participant.on(ParticipantEvent.LocalTrackUnpublished, handleTrackChange);

    return () => {
      participant.off(ParticipantEvent.TrackSubscribed, handleTrackChange);
      participant.off(ParticipantEvent.TrackUnsubscribed, handleTrackChange);
      participant.off(ParticipantEvent.TrackMuted, handleTrackChange);
      participant.off(ParticipantEvent.TrackUnmuted, handleTrackChange);
      participant.off(ParticipantEvent.TrackPublished, handleTrackChange);
      participant.off(ParticipantEvent.TrackUnpublished, handleTrackChange);
      participant.off(ParticipantEvent.LocalTrackPublished, handleTrackChange);
      participant.off(ParticipantEvent.LocalTrackUnpublished, handleTrackChange);
    };
  }, [participant, forceUpdate]);

  // Get video track (camera)
  const videoPublication = participant.getTrackPublication(Track.Source.Camera);
  const videoTrack = videoPublication?.track;

  // Get screen share track
  const screenSharePublication = participant.getTrackPublication(Track.Source.ScreenShare);
  const screenShareTrack = screenSharePublication?.track;

  // Get audio track for status
  const audioPublication = participant.getTrackPublication(Track.Source.Microphone);

  // Check if camera is enabled - different logic for local vs remote
  const isCameraEnabled = useMemo(() => {
    if (isLocal) {
      // For local participant, check if camera is enabled via participant method
      return (participant as LocalParticipant).isCameraEnabled;
    } else {
      // For remote participant, check subscription and track
      return videoPublication?.isSubscribed && !videoPublication?.isMuted && !!videoTrack;
    }
  }, [isLocal, participant, videoPublication, videoTrack]);

  // Check if mic is enabled
  const isMicEnabled = useMemo(() => {
    if (isLocal) {
      return (participant as LocalParticipant).isMicrophoneEnabled;
    } else {
      return audioPublication?.isSubscribed && !audioPublication?.isMuted;
    }
  }, [isLocal, participant, audioPublication]);

  // Check if screen sharing
  const isScreenSharing = useMemo(() => {
    if (isLocal) {
      return (participant as LocalParticipant).isScreenShareEnabled;
    } else {
      return screenSharePublication?.isSubscribed && !screenSharePublication?.isMuted && !!screenShareTrack;
    }
  }, [isLocal, participant, screenSharePublication, screenShareTrack]);

  // Attach video track to element
  useEffect(() => {
    if (videoRef.current && videoTrack) {
      videoTrack.attach(videoRef.current);
      return () => {
        videoTrack.detach(videoRef.current!);
      };
    }
  }, [videoTrack]);

  // Attach screen share track to element
  useEffect(() => {
    if (screenShareRef.current && screenShareTrack) {
      screenShareTrack.attach(screenShareRef.current);
      return () => {
        screenShareTrack.detach(screenShareRef.current!);
      };
    }
  }, [screenShareTrack]);

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

  // Small style for participant strip (during screen share)
  if (isSmall) {
    return (
      <div className="relative w-full h-full bg-meet-bg-secondary rounded-xl overflow-hidden animate-fade-in">
        {isCameraEnabled && videoTrack ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={isLocal}
            className={`w-full h-full object-cover ${isLocal ? 'transform scale-x-[-1]' : ''}`}
          />
        ) : (
          <div className="w-full h-full bg-meet-bg-elevated flex items-center justify-center">
            <div className={`${avatarColor} w-10 h-10 rounded-full flex items-center justify-center`}>
              <span className="text-white font-semibold text-xs">{initials}</span>
            </div>
          </div>
        )}

        {/* Small overlay */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1.5">
          <div className="flex items-center justify-between">
            <span className="text-white text-xs font-medium truncate">
              {isLocal ? 'You' : (participant.name || participant.identity)}
            </span>
            <div className="flex items-center gap-0.5">
              {!isMicEnabled && (
                <div className="bg-meet-error/80 rounded-full p-0.5">
                  <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                  </svg>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl overflow-hidden bg-meet-bg-secondary animate-fade-in">
      {/* Screen share takes priority */}
      {isScreenSharing && screenShareTrack ? (
        <video
          ref={screenShareRef}
          autoPlay
          playsInline
          muted={isLocal}
          className="w-full h-full object-contain bg-black"
        />
      ) : isCameraEnabled && videoTrack ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className={`w-full h-full object-cover ${isLocal ? 'transform scale-x-[-1]' : ''}`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-meet-bg-secondary">
          <div className={`${avatarColor} w-24 h-24 rounded-full flex items-center justify-center shadow-lg`}>
            <span className="text-white font-semibold text-3xl">{initials}</span>
          </div>
        </div>
      )}

      {/* Participant overlay */}
      <ParticipantOverlay
        name={isLocal ? 'You' : (participant.name || participant.identity)}
        isMicEnabled={!!isMicEnabled}
        isLocal={isLocal}
        isScreenSharing={!!isScreenSharing}
      />
    </div>
  );
}

export default VideoTile;
