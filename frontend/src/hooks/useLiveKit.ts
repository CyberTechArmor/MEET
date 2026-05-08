import { useCallback, useRef } from 'react';
import {
  Room,
  RoomEvent,
  ConnectionState,
  RemoteParticipant,
  LocalParticipant,
  Track,
  LocalTrackPublication,
  TrackPublication,
  Participant,
} from 'livekit-client';
import toast from 'react-hot-toast';
import { useRoomStore } from '../stores/roomStore';
import { createRoom, getToken, getLiveKitUrl, saveSession, clearSession, endMeetingForAll, setVideoQualityPreset } from '../lib/livekit';

// Singleton room instance shared across all hook instances
let sharedRoomInstance: Room | null = null;

export function useLiveKit() {
  const roomRef = useRef<Room | null>(null);
  const {
    setRoom,
    setConnectionState,
    setLocalParticipant,
    setRemoteParticipants,
    addRemoteParticipant,
    removeRemoteParticipant,
    setMicEnabled,
    setCameraEnabled,
    setScreenSharing,
    setActiveScreenShareIdentity,
    setIsHost,
    setRoomCode,
    setView,
    resetKeepingName,
    roomCode: storedRoomCode,
    isHost,
    localParticipant,
  } = useRoomStore();

  // Initialize room event handlers
  const setupRoomEvents = useCallback((room: Room) => {
    room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      setConnectionState(state);

      if (state === ConnectionState.Disconnected) {
        toast.error('Disconnected from room');
      } else if (state === ConnectionState.Reconnecting) {
        toast('Reconnecting...', { icon: '🔄' });
      } else if (state === ConnectionState.Connected) {
        toast.success('Connected!');
      }
    });

    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      addRemoteParticipant(participant);
      const displayName = participant.name || participant.identity;
      toast.success(`${displayName} joined`);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      removeRemoteParticipant(participant.identity);
      const displayName = participant.name || participant.identity;
      toast(`${displayName} left`, { icon: '👋' });
    });

    // Handle track events to force UI updates
    const updateParticipants = () => {
      setRemoteParticipants(Array.from(room.remoteParticipants.values()));
    };

    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      updateParticipants();
      // When a remote participant starts screen sharing, they become the active sharer (last wins)
      if (track.source === Track.Source.ScreenShare) {
        setActiveScreenShareIdentity(participant.identity);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      updateParticipants();
      // If the active sharer stops, find the next available or clear
      if (track.source === Track.Source.ScreenShare) {
        const currentActive = useRoomStore.getState().activeScreenShareIdentity;
        if (currentActive === participant.identity) {
          // Check if local is sharing
          const localPub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
          if (localPub?.track && !localPub.isMuted) {
            setActiveScreenShareIdentity(room.localParticipant.identity);
          } else {
            // Find another remote still sharing
            let nextSharer: string | null = null;
            for (const remote of room.remoteParticipants.values()) {
              if (remote.identity === participant.identity) continue;
              const pub = remote.getTrackPublication(Track.Source.ScreenShare);
              if (pub?.track && !pub.isMuted) {
                nextSharer = remote.identity;
                break;
              }
            }
            setActiveScreenShareIdentity(nextSharer);
          }
        }
      }
    });
    room.on(RoomEvent.TrackMuted, updateParticipants);
    room.on(RoomEvent.TrackUnmuted, updateParticipants);
    room.on(RoomEvent.TrackPublished, updateParticipants);
    room.on(RoomEvent.TrackUnpublished, updateParticipants);

    room.on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
      if (publication.track?.kind === Track.Kind.Video) {
        if (publication.track.source === Track.Source.ScreenShare) {
          setScreenSharing(true);
          // Last screen share wins — set this as the active screen share for everyone
          setActiveScreenShareIdentity(room.localParticipant.identity);
        } else if (publication.track.source === Track.Source.Camera) {
          setCameraEnabled(true);
        }
      } else if (publication.track?.kind === Track.Kind.Audio) {
        if (publication.track.source === Track.Source.Microphone) {
          setMicEnabled(true);
        }
      }
    });

    room.on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
      if (publication.track?.kind === Track.Kind.Video) {
        if (publication.track.source === Track.Source.ScreenShare) {
          setScreenSharing(false);
          // If the local user was the active sharer, find the next available or clear
          const currentActive = useRoomStore.getState().activeScreenShareIdentity;
          if (currentActive === room.localParticipant.identity) {
            // Look for another participant still sharing
            let nextSharer: string | null = null;
            for (const remote of room.remoteParticipants.values()) {
              const pub = remote.getTrackPublication(Track.Source.ScreenShare);
              if (pub?.track && !pub.isMuted) {
                nextSharer = remote.identity;
                break;
              }
            }
            setActiveScreenShareIdentity(nextSharer);
          }
        } else if (publication.track.source === Track.Source.Camera) {
          setCameraEnabled(false);
        }
      } else if (publication.track?.kind === Track.Kind.Audio) {
        if (publication.track.source === Track.Source.Microphone) {
          setMicEnabled(false);
        }
      }
    });

    // Handle local track mute/unmute to keep UI in sync
    // Only respond to local participant track events
    room.on(RoomEvent.TrackMuted, (publication: TrackPublication, participant: Participant) => {
      // Only update state for local participant
      if (participant instanceof LocalParticipant) {
        if (publication.track?.source === Track.Source.Camera) {
          setCameraEnabled(false);
        } else if (publication.track?.source === Track.Source.Microphone) {
          setMicEnabled(false);
        }
      }
    });

    room.on(RoomEvent.TrackUnmuted, (publication: TrackPublication, participant: Participant) => {
      // Only update state for local participant
      if (participant instanceof LocalParticipant) {
        if (publication.track?.source === Track.Source.Camera) {
          setCameraEnabled(true);
        } else if (publication.track?.source === Track.Source.Microphone) {
          setMicEnabled(true);
        }
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      setConnectionState(ConnectionState.Disconnected);
      // Clear session and reset state, keeping the display name
      clearSession();
      sharedRoomInstance = null;
      resetKeepingName();
      setView('join');
    });

    room.on(RoomEvent.MediaDevicesError, (error: Error) => {
      console.error('Media device error:', error);
      toast.error(`Media error: ${error.message}`);
    });
  }, [
    setConnectionState,
    addRemoteParticipant,
    removeRemoteParticipant,
    setRemoteParticipants,
    setScreenSharing,
    setActiveScreenShareIdentity,
    setMicEnabled,
    setCameraEnabled,
    resetKeepingName,
    setView,
  ]);

  // Connect to room
  const connect = useCallback(async (roomCode: string, displayName: string) => {
    try {
      setConnectionState(ConnectionState.Connecting);

      // Get token from API
      const tokenResponse = await getToken(roomCode, displayName);
      const { token, isHost: hostStatus, quality, iceServers } = tokenResponse;

      // Server picked a quality preset for this room (per-room override or
      // platform default). Apply it before we build the room options below
      // so the room picks up the right simulcast layers / codec / etc.
      if (quality) {
        setVideoQualityPreset(quality);
      }

      // Set host status and room code
      setIsHost(hostStatus);
      setRoomCode(roomCode);

      // Create room and setup events
      const newRoom = createRoom();
      roomRef.current = newRoom;
      sharedRoomInstance = newRoom; // Store in singleton for cross-component access
      setupRoomEvents(newRoom);

      // Connect to LiveKit. If the API issued TURN servers (i.e.
      // TURN_ENABLED=true on the backend), pass them in via rtcConfig so
      // the browser's ICE gatherer can use them. Without this, cellular
      // clients can't reach the LXC media path even when the TURN server
      // is up and listening.
      const connectOpts = iceServers && iceServers.length > 0
        ? { rtcConfig: { iceServers } as RTCConfiguration }
        : undefined;
      await newRoom.connect(getLiveKitUrl(), token, connectOpts);

      // Transition to the room view IMMEDIATELY after the signaling
      // connection is up. Don't wait for track publishing — on a slow or
      // symmetric-NAT'd network (cellular without TURN), setMic/setCamera
      // can stall waiting for ICE to establish, never resolving and never
      // rejecting. That used to leave the join screen showing "Connected"
      // with mic/camera permissions granted by the OS but the user never
      // moving to the call UI. Each track now publishes independently and
      // its own state flag flips when it lands.
      setRoom(newRoom);
      setLocalParticipant(newRoom.localParticipant);
      setRemoteParticipants(Array.from(newRoom.remoteParticipants.values()));
      setView('room');

      // Save session for auto-rejoin on refresh
      saveSession(roomCode, displayName, hostStatus);

      // Fire-and-forget mic + camera. Promise.then/.catch instead of await,
      // so a stuck publish never blocks the UI. The VideoRoom component
      // listens for LocalTrackPublished and re-renders when the track lands.
      newRoom.localParticipant.setMicrophoneEnabled(true).then(
        () => setMicEnabled(true),
        (err) => {
          console.warn('Could not enable microphone:', err);
          toast('Microphone unavailable', { icon: '🔇' });
        },
      );
      newRoom.localParticipant.setCameraEnabled(true).then(
        () => setCameraEnabled(true),
        (err) => {
          console.warn('Could not enable camera:', err);
          toast('Camera unavailable', { icon: '📷' });
        },
      );

    } catch (error) {
      console.error('Failed to connect:', error);
      setConnectionState(ConnectionState.Disconnected);

      if (error instanceof Error) {
        if (error.message.includes('Permission denied') || error.message.includes('NotAllowedError')) {
          toast.error('Camera/microphone permission denied. Please allow access and try again.');
        } else {
          toast.error(error.message);
        }
      } else {
        toast.error('Failed to connect to room');
      }

      throw error;
    }
  }, [
    setupRoomEvents,
    setRoom,
    setConnectionState,
    setLocalParticipant,
    setRemoteParticipants,
    setMicEnabled,
    setCameraEnabled,
    setIsHost,
    setRoomCode,
    setView,
  ]);

  // Disconnect from room
  const disconnect = useCallback(async () => {
    // Clear saved session
    clearSession();

    if (sharedRoomInstance) {
      await sharedRoomInstance.disconnect();
      sharedRoomInstance = null;
    }
    if (roomRef.current) {
      roomRef.current = null;
    }
    // Keep the display name so it's prefilled on the join form
    resetKeepingName();
    setView('join');
  }, [resetKeepingName, setView]);

  // Toggle microphone
  const toggleMic = useCallback(async () => {
    const currentRoom = sharedRoomInstance;
    if (!currentRoom?.localParticipant) {
      console.warn('toggleMic: No room or local participant available');
      return;
    }

    try {
      const newState = !currentRoom.localParticipant.isMicrophoneEnabled;
      console.log('toggleMic: Setting mic to', newState);
      await currentRoom.localParticipant.setMicrophoneEnabled(newState);
      setMicEnabled(newState);
    } catch (error) {
      console.error('Failed to toggle microphone:', error);
      toast.error('Failed to toggle microphone');
    }
  }, [setMicEnabled]);

  // Toggle camera
  const toggleCamera = useCallback(async () => {
    const currentRoom = sharedRoomInstance;
    if (!currentRoom?.localParticipant) {
      console.warn('toggleCamera: No room or local participant available');
      return;
    }

    try {
      const newState = !currentRoom.localParticipant.isCameraEnabled;
      console.log('toggleCamera: Setting camera to', newState);
      await currentRoom.localParticipant.setCameraEnabled(newState);
      setCameraEnabled(newState);
    } catch (error) {
      console.error('Failed to toggle camera:', error);
      toast.error('Failed to toggle camera');
    }
  }, [setCameraEnabled]);

  // Toggle screen share
  const toggleScreenShare = useCallback(async () => {
    const currentRoom = sharedRoomInstance;
    if (!currentRoom?.localParticipant) {
      console.warn('toggleScreenShare: No room or local participant available');
      return;
    }

    const isCurrentlySharing = currentRoom.localParticipant.isScreenShareEnabled;

    try {
      if (isCurrentlySharing) {
        console.log('toggleScreenShare: Stopping screen share');
        await currentRoom.localParticipant.setScreenShareEnabled(false);
        setScreenSharing(false);
      } else {
        console.log('toggleScreenShare: Starting screen share');
        await currentRoom.localParticipant.setScreenShareEnabled(true);
        setScreenSharing(true);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Permission denied')) {
        // User cancelled screen share picker
        console.log('Screen share cancelled by user');
      } else {
        console.error('Failed to toggle screen share:', error);
        toast.error('Failed to toggle screen share');
      }
    }
  }, [setScreenSharing]);

  // End meeting for all participants (host only)
  const endMeeting = useCallback(async () => {
    if (!isHost) {
      toast.error('Only the host can end the meeting');
      return;
    }

    if (!storedRoomCode || !localParticipant) {
      toast.error('Unable to end meeting');
      return;
    }

    try {
      await endMeetingForAll(storedRoomCode, localParticipant.identity);
      toast.success('Meeting ended for all participants');
      // The room disconnect event will handle cleanup
    } catch (error) {
      console.error('Failed to end meeting:', error);
      toast.error('Failed to end meeting');
    }
  }, [isHost, storedRoomCode, localParticipant]);

  // Note: We intentionally don't disconnect on unmount since we use a singleton pattern.
  // The room should only be disconnected explicitly via the disconnect() function.
  // This prevents the room from disconnecting when components re-render or unmount
  // during view transitions (e.g., JoinForm -> VideoRoom).

  return {
    connect,
    disconnect,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    endMeeting,
  };
}
