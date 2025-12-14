interface ParticipantOverlayProps {
  name: string;
  isMicEnabled: boolean;
  isLocal: boolean;
  isScreenSharing: boolean;
}

function ParticipantOverlay({
  name,
  isMicEnabled,
  isScreenSharing,
}: ParticipantOverlayProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-4">
      <div className="flex items-center justify-between">
        {/* Name */}
        <div className="flex items-center gap-2">
          <span className="text-white font-medium text-sm truncate max-w-[200px]">
            {name}
          </span>
          {isScreenSharing && (
            <span className="bg-meet-success/20 text-meet-success text-xs px-2 py-0.5 rounded-full border border-meet-success/30">
              Sharing
            </span>
          )}
        </div>

        {/* Mic status */}
        <div className="flex items-center gap-2">
          {!isMicEnabled && (
            <div className="bg-meet-error/80 rounded-full p-1.5" title="Microphone muted">
              <svg
                className="w-4 h-4 text-white"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"
                />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ParticipantOverlay;
