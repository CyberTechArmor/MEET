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
                  d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 3l18 18"
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
