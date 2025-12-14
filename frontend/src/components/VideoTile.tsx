import { useEffect, useRef, useMemo } from 'react';
import { Participant, Track, TrackPublication } from 'livekit-client';
import ParticipantOverlay from './ParticipantOverlay';

interface VideoTileProps {
  participant: Participant;
  isLocal: boolean;
  isSmall?: boolean;
}

function VideoTile({ participant, isLocal, isSmall = false }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const screenShareRef = useRef<HTMLVideoElement>(null);

  // Get video track (camera)
  const videoTrack = useMemo(() => {
    const publication = participant.getTrackPublication(Track.Source.Camera);
    return publication?.track;
  }, [participant]);

  // Get screen share track
  const screenShareTrack = useMemo(() => {
    const publication = participant.getTrackPublication(Track.Source.ScreenShare);
    return publication?.track;
  }, [participant]);

  // Get audio track for status
  const audioPublication = useMemo(() => {
    return participant.getTrackPublication(Track.Source.Microphone);
  }, [participant]);

  // Check if camera is enabled
  const isCameraEnabled = useMemo(() => {
    const pub = participant.getTrackPublication(Track.Source.Camera) as TrackPublication | undefined;
    return pub?.isSubscribed && !pub?.isMuted;
  }, [participant]);

  // Check if mic is enabled
  const isMicEnabled = useMemo(() => {
    return audioPublication?.isSubscribed && !audioPublication?.isMuted;
  }, [audioPublication]);

  // Check if screen sharing
  const isScreenSharing = useMemo(() => {
    const pub = participant.getTrackPublication(Track.Source.ScreenShare) as TrackPublication | undefined;
    return pub?.isSubscribed && !pub?.isMuted;
  }, [participant]);

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

  // Small pip style for local video when in call
  if (isSmall && isLocal) {
    return (
      <div className="absolute bottom-24 right-4 z-10 w-48 aspect-video rounded-xl overflow-hidden shadow-soft border border-meet-border animate-fade-in">
        {isCameraEnabled && videoTrack ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={isLocal}
            className="w-full h-full object-cover transform scale-x-[-1]"
          />
        ) : (
          <div className="w-full h-full bg-meet-bg-elevated flex items-center justify-center">
            <div className={`${avatarColor} w-12 h-12 rounded-full flex items-center justify-center`}>
              <span className="text-white font-semibold text-sm">{initials}</span>
            </div>
          </div>
        )}

        {/* Small overlay */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
          <div className="flex items-center justify-between">
            <span className="text-white text-xs font-medium truncate">
              You
            </span>
            <div className="flex items-center gap-1">
              {!isMicEnabled && (
                <div className="bg-meet-error/80 rounded-full p-1">
                  <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
