import { useEffect, useRef } from 'react';
import { ConnectionState, DisconnectReason, Track } from 'livekit-client';
import { useRoomStore } from '../stores/roomStore';
import { useLiveKit } from './useLiveKit';
import { useDocumentPip } from './useDocumentPip';
import { isHosted, onHostCommand, postToHost, type LeftReason } from '../lib/embedBridge';

const APP_VERSION = '1.0.0';

function leftReason(reason: number | null): LeftReason {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED: return 'left';
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED: return 'ended';
    case DisconnectReason.PARTICIPANT_REMOVED: return 'removed';
    case DisconnectReason.DUPLICATE_IDENTITY: return 'duplicate';
    case null: return 'unknown';
    default: return 'connection-lost';
  }
}

/**
 * Mirrors call state to the host page and executes its commands.
 * Mounted once in App. The host is the embedding page when MEET is in an
 * iframe, or window.opener when a host popped MEET out into its own window;
 * with neither, this does nothing.
 */
export function useEmbedBridge(compact: boolean) {
  const { disconnect, endMeeting, toggleMic, toggleCamera, toggleScreenShare } = useLiveKit();
  const pip = useDocumentPip();
  const joinedAtRef = useRef<number | null>(null);
  const prevRef = useRef<{ view?: string; conn?: string; parts?: string; share?: string; media?: string }>({});
  const hosted = isHosted();

  // ── ready ──
  useEffect(() => {
    if (!hosted) return;
    const s = useRoomStore.getState();
    postToHost({ type: 'meet:ready', embed: s.embedMode, room: s.embedRoomCode || s.roomCode || null, version: APP_VERSION });
  }, [hosted]);

  // ── layout ──
  useEffect(() => {
    if (hosted) postToHost({ type: 'meet:layout', compact });
  }, [hosted, compact]);

  // ── state → events ──
  useEffect(() => {
    if (!hosted) return;
    const emit = () => {
      const s = useRoomStore.getState();
      const room = s.roomCode || s.embedRoomCode;
      const prev = prevRef.current;

      // joined / joining / reconnecting / left
      const conn = `${s.view}:${s.connectionState}:${s.lastDisconnectReason}`;
      if (conn !== prev.conn) {
        prev.conn = conn;
        if (s.view === 'room' && s.connectionState === ConnectionState.Connected) {
          if (!joinedAtRef.current) {
            joinedAtRef.current = Date.now();
            postToHost({
              type: 'meet:joined', room, identity: s.localParticipant?.identity ?? '',
              name: s.localParticipant?.name || s.displayName, isHost: s.isHost, joinedAt: joinedAtRef.current,
            });
          }
        } else if (s.view === 'room' && s.connectionState === ConnectionState.Reconnecting) {
          postToHost({ type: 'meet:reconnecting', room });
        } else if (s.view === 'join' && s.connectionState === ConnectionState.Connecting) {
          postToHost({ type: 'meet:joining', room, name: s.displayName });
        } else if (s.view === 'join' && joinedAtRef.current) {
          joinedAtRef.current = null;
          const reason = leftReason(s.lastDisconnectReason);
          const willRejoin = s.embedMode && s.embedAutoJoin && (reason === 'connection-lost' || reason === 'unknown');
          postToHost({ type: 'meet:left', room, reason, willRejoin });
        }
      }

      // participants
      const list = s.remoteParticipants.map((p) => ({ identity: p.identity, name: p.name || p.identity }));
      const parts = JSON.stringify(list);
      if (parts !== prev.parts && s.view === 'room') {
        prev.parts = parts;
        postToHost({ type: 'meet:participants', room, count: list.length + 1, participants: list });
      }

      // screen share
      let by: string | null = null; let local = false;
      if (s.activeScreenShareIdentity) {
        if (s.localParticipant?.identity === s.activeScreenShareIdentity) { by = 'You'; local = true; }
        else {
          const r = s.remoteParticipants.find((p) => p.identity === s.activeScreenShareIdentity);
          by = r ? (r.name || r.identity) : null;
        }
      } else if (s.isScreenSharing) { by = 'You'; local = true; }
      const share = `${by}:${local}`;
      if (share !== prev.share && s.view === 'room') {
        prev.share = share;
        postToHost({ type: 'meet:screenshare', room, active: by !== null, by, local });
      }

      // media
      const media = `${s.isMicEnabled}:${s.isCameraEnabled}`;
      if (media !== prev.media && s.view === 'room') {
        prev.media = media;
        postToHost({ type: 'meet:media', room, audio: s.isMicEnabled, video: s.isCameraEnabled });
      }
    };
    emit();
    return useRoomStore.subscribe(emit);
  }, [hosted]);

  // ── commands ──
  useEffect(() => {
    if (!hosted) return;
    return onHostCommand(async (cmd) => {
      const s = useRoomStore.getState();
      const fail = (message: string) => postToHost({ type: 'meet:error', command: cmd.type, message });
      try {
        switch (cmd.type) {
          case 'meet:leave':
            if (s.view === 'room') await disconnect();
            break;
          case 'meet:end':
            if (s.view === 'room' && s.isHost) await endMeeting();
            else fail('Only the host can end the meeting');
            break;
          case 'meet:mute':
            if (s.view !== 'room') break;
            if (cmd.audio !== undefined && cmd.audio === s.isMicEnabled) await toggleMic();
            if (cmd.video !== undefined && cmd.video === s.isCameraEnabled) await toggleCamera();
            break;
          case 'meet:screenshare':
            if (s.view !== 'room') break;
            if (cmd.enabled !== s.isScreenSharing) await toggleScreenShare();
            break;
          case 'meet:compact':
            s.setCompactOverride(cmd.mode === 'on' || cmd.mode === 'off' ? cmd.mode : 'auto');
            break;
          case 'meet:hideEndCall':
            s.setHideEndCall(!!cmd.hide);
            break;
          case 'meet:pip':
            if (!pip.supported) { fail('Document Picture-in-Picture is not supported in this browser'); break; }
            if (cmd.open === false) pip.close();
            else if (cmd.open === true) await pip.open();
            else await pip.toggle();
            break;
          case 'meet:fullscreen': {
            const enter = cmd.enter !== false;
            if (enter) await document.documentElement.requestFullscreen();
            else if (document.fullscreenElement) await document.exitFullscreen();
            break;
          }
          case 'meet:get-state':
            postToHost({
              type: 'meet:state',
              state: {
                view: s.view, connectionState: s.connectionState, room: s.roomCode || s.embedRoomCode,
                name: s.displayName, identity: s.localParticipant?.identity ?? null, isHost: s.isHost,
                joinedAt: joinedAtRef.current, participants: s.remoteParticipants.length + (s.view === 'room' ? 1 : 0),
                audio: s.isMicEnabled, video: s.isCameraEnabled, screenSharing: s.isScreenSharing,
                activeScreenShare: s.activeScreenShareIdentity, compact, pip: s.pipOpen, embed: s.embedMode,
              },
            });
            break;
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    });
  }, [hosted, compact, disconnect, endMeeting, toggleMic, toggleCamera, toggleScreenShare, pip]);

  // Keep Track import used for type narrowing in chooseTrack callers.
  void Track;
}
