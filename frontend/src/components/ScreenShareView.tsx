import { useEffect, useRef, useMemo } from 'react';
import { Participant, Track } from 'livekit-client';

interface ScreenShareViewProps {
  participant: Participant;
  isLocal: boolean;
}

function ScreenShareView({ participant, isLocal }: ScreenShareViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Get screen share track
  const screenSharePublication = participant.getTrackPublication(Track.Source.ScreenShare);
  const screenShareTrack = screenSharePublication?.track;

  // Attach screen share track to element
  useEffect(() => {
    if (videoRef.current && screenShareTrack) {
      screenShareTrack.attach(videoRef.current);
      return () => {
        screenShareTrack.detach(videoRef.current!);
      };
    }
  }, [screenShareTrack]);

  // Generate participant name
  const displayName = useMemo(() => {
    if (isLocal) return 'You';
    return participant.name || participant.identity;
  }, [isLocal, participant]);

  if (!screenShareTrack) {
    return null;
  }

  return (
    <div className="relative w-full h-full bg-black rounded-2xl overflow-hidden">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className="w-full h-full object-contain"
      />

      {/* Screen share presenter info */}
      <div className="absolute bottom-4 left-4 bg-black/70 rounded-lg px-3 py-2 flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-meet-success animate-pulse" />
        <span className="text-white text-sm font-medium">
          {displayName}&apos;s screen
        </span>
      </div>
    </div>
  );
}

export default ScreenShareView;
