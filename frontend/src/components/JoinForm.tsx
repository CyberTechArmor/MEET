import { useState, FormEvent, useCallback } from 'react';
import { ConnectionState } from 'livekit-client';
import { useRoomStore } from '../stores/roomStore';
import { useLiveKit } from '../hooks/useLiveKit';
import { generateRoomCode, formatRoomCode, parseRoomCode } from '../lib/livekit';

function JoinForm() {
  const { displayName, setDisplayName, roomCode, setRoomCode, connectionState } = useRoomStore();
  const { connect } = useLiveKit();

  const [mode, setMode] = useState<'create' | 'join' | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isConnecting = connectionState === ConnectionState.Connecting;

  const handleGenerateCode = useCallback(async () => {
    setIsGenerating(true);
    try {
      const code = await generateRoomCode();
      setRoomCode(code);
    } catch (err) {
      console.error('Failed to generate code:', err);
    } finally {
      setIsGenerating(false);
    }
  }, [setRoomCode]);

  const handleCreateRoom = useCallback(async () => {
    setMode('create');
    await handleGenerateCode();
  }, [handleGenerateCode]);

  const handleJoinRoom = useCallback(() => {
    setMode('join');
    setRoomCode('');
  }, [setRoomCode]);

  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!displayName.trim()) {
      setError('Please enter your name');
      return;
    }

    if (!roomCode.trim() || roomCode.length < 4) {
      setError('Please enter a valid room code');
      return;
    }

    try {
      await connect(roomCode, displayName.trim());
    } catch (err) {
      // Error is already handled in useLiveKit
      console.error('Connection failed:', err);
    }
  }, [displayName, roomCode, connect]);

  const handleRoomCodeChange = useCallback((value: string) => {
    const parsed = parseRoomCode(value);
    setRoomCode(parsed);
  }, [setRoomCode]);

  const handleBack = useCallback(() => {
    setMode(null);
    setRoomCode('');
    setError(null);
  }, [setRoomCode]);

  return (
    <div className="min-h-full flex flex-col items-center justify-center p-6">
      {/* Logo */}
      <div className="mb-12 text-center">
        <h1 className="font-display text-5xl font-bold text-meet-text-primary mb-2 tracking-tight">
          MEET
        </h1>
        <p className="text-meet-text-secondary text-lg">
          Video conferencing, simplified
        </p>
      </div>

      {/* Card */}
      <div className="glass rounded-2xl p-8 w-full max-w-md shadow-soft animate-fade-in">
        {/* Name Input - Always visible */}
        <div className="mb-6">
          <label
            htmlFor="displayName"
            className="block text-sm font-medium text-meet-text-secondary mb-2"
          >
            Your name
          </label>
          <input
            id="displayName"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Enter your name"
            className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none"
            maxLength={50}
            disabled={isConnecting}
          />
        </div>

        {/* Mode Selection or Form */}
        {!mode ? (
          <div className="space-y-3">
            <button
              onClick={handleCreateRoom}
              disabled={!displayName.trim()}
              className="w-full bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-semibold py-3 px-6 rounded-xl transition-smooth disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create a new room
            </button>
            <button
              onClick={handleJoinRoom}
              disabled={!displayName.trim()}
              className="w-full bg-meet-bg-tertiary hover:bg-meet-bg-elevated border border-meet-border text-meet-text-primary font-semibold py-3 px-6 rounded-xl transition-smooth disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14" />
              </svg>
              Join existing room
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Room Code Section */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label
                  htmlFor="roomCode"
                  className="block text-sm font-medium text-meet-text-secondary"
                >
                  Room code
                </label>
                {mode === 'create' && (
                  <button
                    type="button"
                    onClick={handleGenerateCode}
                    disabled={isGenerating}
                    className="text-sm text-meet-accent hover:text-meet-accent-light transition-smooth disabled:opacity-50"
                  >
                    {isGenerating ? 'Generating...' : 'New code'}
                  </button>
                )}
              </div>
              <input
                id="roomCode"
                type="text"
                value={formatRoomCode(roomCode)}
                onChange={(e) => handleRoomCodeChange(e.target.value)}
                placeholder={mode === 'create' ? 'Generating...' : 'Enter code (e.g., ABC-123)'}
                className="w-full bg-meet-bg-tertiary border border-meet-border rounded-xl px-4 py-3 text-meet-text-primary placeholder-meet-text-disabled focus:border-meet-accent focus:ring-1 focus:ring-meet-accent transition-smooth outline-none text-center text-2xl font-mono tracking-widest uppercase"
                maxLength={7}
                disabled={isConnecting || (mode === 'create' && isGenerating)}
                readOnly={mode === 'create'}
              />
              {mode === 'create' && roomCode && (
                <p className="mt-2 text-sm text-meet-text-tertiary text-center">
                  Share this code with others to join
                </p>
              )}
            </div>

            {/* Error Message */}
            {error && (
              <div className="bg-meet-error/10 border border-meet-error/30 rounded-lg px-4 py-2 text-meet-error text-sm">
                {error}
              </div>
            )}

            {/* Buttons */}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleBack}
                disabled={isConnecting}
                className="flex-1 bg-meet-bg-tertiary hover:bg-meet-bg-elevated border border-meet-border text-meet-text-primary font-medium py-3 px-4 rounded-xl transition-smooth disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={isConnecting || !roomCode}
                className="flex-1 bg-meet-accent hover:bg-meet-accent-dark text-meet-bg font-semibold py-3 px-4 rounded-xl transition-smooth disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isConnecting ? (
                  <>
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
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
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    Connecting...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    {mode === 'create' ? 'Start Call' : 'Join Call'}
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Footer */}
      <div className="mt-8 text-center text-meet-text-tertiary text-sm">
        <p>No account required. Your data stays private.</p>
      </div>
    </div>
  );
}

export default JoinForm;
