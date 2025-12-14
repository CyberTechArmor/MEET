import { useCallback, useState } from 'react';
import { useRoomStore } from '../stores/roomStore';
import { useLiveKit } from '../hooks/useLiveKit';

function ControlBar() {
  const { isMicEnabled, isCameraEnabled, isScreenSharing } = useRoomStore();
  const { toggleMic, toggleCamera, toggleScreenShare, disconnect } = useLiveKit();

  const [isLeaving, setIsLeaving] = useState(false);

  const handleLeave = useCallback(async () => {
    setIsLeaving(true);
    await disconnect();
  }, [disconnect]);

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30">
      <div className="glass rounded-2xl px-4 py-3 flex items-center gap-2 shadow-soft">
        {/* Microphone Toggle */}
        <button
          onClick={toggleMic}
          className={`relative p-4 rounded-xl transition-smooth ${
            isMicEnabled
              ? 'bg-meet-bg-tertiary hover:bg-meet-bg-elevated text-meet-text-primary'
              : 'bg-meet-error hover:bg-meet-error/80 text-white'
          }`}
          title={isMicEnabled ? 'Mute microphone' : 'Unmute microphone'}
        >
          {isMicEnabled ? (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 3l18 18"
              />
            </svg>
          )}
        </button>

        {/* Camera Toggle */}
        <button
          onClick={toggleCamera}
          className={`relative p-4 rounded-xl transition-smooth ${
            isCameraEnabled
              ? 'bg-meet-bg-tertiary hover:bg-meet-bg-elevated text-meet-text-primary'
              : 'bg-meet-error hover:bg-meet-error/80 text-white'
          }`}
          title={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'}
        >
          {isCameraEnabled ? (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
              />
            </svg>
          )}
        </button>

        {/* Screen Share Toggle */}
        <button
          onClick={toggleScreenShare}
          className={`relative p-4 rounded-xl transition-smooth ${
            isScreenSharing
              ? 'bg-meet-success hover:bg-meet-success/80 text-white'
              : 'bg-meet-bg-tertiary hover:bg-meet-bg-elevated text-meet-text-primary'
          }`}
          title={isScreenSharing ? 'Stop sharing' : 'Share screen'}
        >
          {isScreenSharing ? (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
          )}
          {isScreenSharing && (
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-meet-success rounded-full animate-pulse" />
          )}
        </button>

        {/* Divider */}
        <div className="w-px h-8 bg-meet-border mx-2" />

        {/* Leave Call */}
        <button
          onClick={handleLeave}
          disabled={isLeaving}
          className="p-4 rounded-xl bg-meet-error hover:bg-meet-error/80 text-white transition-smooth disabled:opacity-50 disabled:cursor-not-allowed"
          title="Leave call"
        >
          {isLeaving ? (
            <svg className="w-6 h-6 animate-spin" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          ) : (
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.28 3H5z"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export default ControlBar;
