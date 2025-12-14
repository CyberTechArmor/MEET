import { useCallback, useEffect, useRef } from 'react';
import {
  Room,
  RoomEvent,
  ConnectionState,
  RemoteParticipant,
  Track,
  LocalTrackPublication,
} from 'livekit-client';
import toast from 'react-hot-toast';
import { useRoomStore } from '../stores/roomStore';
import { createRoom, getToken, getLiveKitUrl } from '../lib/livekit';

export function useLiveKit() {
  const roomRef = useRef<Room | null>(null);
  const {
    room,
    setRoom,
    setConnectionState,
    setLocalParticipant,
    setRemoteParticipants,
    addRemoteParticipant,
    removeRemoteParticipant,
    setMicEnabled,
    setCameraEnabled,
    setScreenSharing,
    setView,
    reset,
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
      toast.success(`${participant.identity} joined`);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      removeRemoteParticipant(participant.identity);
      toast(`${participant.identity} left`, { icon: '👋' });
    });

    // Handle track events to force UI updates
    const updateParticipants = () => {
      setRemoteParticipants(Array.from(room.remoteParticipants.values()));
    };

    room.on(RoomEvent.TrackSubscribed, updateParticipants);
    room.on(RoomEvent.TrackUnsubscribed, updateParticipants);
    room.on(RoomEvent.TrackMuted, updateParticipants);
    room.on(RoomEvent.TrackUnmuted, updateParticipants);
    room.on(RoomEvent.TrackPublished, updateParticipants);
    room.on(RoomEvent.TrackUnpublished, updateParticipants);

    room.on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
      if (publication.track?.kind === Track.Kind.Video) {
        if (publication.track.source === Track.Source.ScreenShare) {
          setScreenSharing(true);
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
    room.on(RoomEvent.TrackMuted, (publication) => {
      if (publication.track?.source === Track.Source.Camera) {
        setCameraEnabled(false);
      } else if (publication.track?.source === Track.Source.Microphone) {
        setMicEnabled(false);
      }
    });

    room.on(RoomEvent.TrackUnmuted, (publication) => {
      if (publication.track?.source === Track.Source.Camera) {
        setCameraEnabled(true);
      } else if (publication.track?.source === Track.Source.Microphone) {
        setMicEnabled(true);
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      setConnectionState(ConnectionState.Disconnected);
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
    setMicEnabled,
    setCameraEnabled,
  ]);

  // Connect to room
  const connect = useCallback(async (roomCode: string, displayName: string) => {
    try {
      setConnectionState(ConnectionState.Connecting);

      // Get token from API
      const { token } = await getToken(roomCode, displayName);

      // Create room and setup events
      const newRoom = createRoom();
      roomRef.current = newRoom;
      setupRoomEvents(newRoom);

      // Connect to LiveKit
      await newRoom.connect(getLiveKitUrl(), token);

      // Try to enable camera and microphone, but handle missing devices gracefully
      let micEnabled = false;
      let cameraEnabled = false;

      // Try to enable microphone
      try {
        await newRoom.localParticipant.setMicrophoneEnabled(true);
        micEnabled = true;
      } catch (micError) {
        console.warn('Could not enable microphone:', micError);
        // Continue without microphone
      }

      // Try to enable camera
      try {
        await newRoom.localParticipant.setCameraEnabled(true);
        cameraEnabled = true;
      } catch (cameraError) {
        console.warn('Could not enable camera:', cameraError);
        // Continue without camera
      }

      // Notify user if devices are missing
      if (!micEnabled && !cameraEnabled) {
        toast('Joined without camera/microphone', { icon: '📺' });
      } else if (!micEnabled) {
        toast('No microphone detected', { icon: '🔇' });
      } else if (!cameraEnabled) {
        toast('No camera detected', { icon: '📷' });
      }

      setRoom(newRoom);
      setLocalParticipant(newRoom.localParticipant);
      setRemoteParticipants(Array.from(newRoom.remoteParticipants.values()));
      setMicEnabled(micEnabled);
      setCameraEnabled(cameraEnabled);
      setView('room');

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
    setView,
  ]);

  // Disconnect from room
  const disconnect = useCallback(async () => {
    if (roomRef.current) {
      await roomRef.current.disconnect();
      roomRef.current = null;
    }
    reset();
    setView('join');
  }, [reset, setView]);

  // Toggle microphone
  const toggleMic = useCallback(async () => {
    if (!room?.localParticipant) return;

    const newState = !room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(newState);
    setMicEnabled(newState);
  }, [room, setMicEnabled]);

  // Toggle camera
  const toggleCamera = useCallback(async () => {
    if (!room?.localParticipant) return;

    const newState = !room.localParticipant.isCameraEnabled;
    await room.localParticipant.setCameraEnabled(newState);
    setCameraEnabled(newState);
  }, [room, setCameraEnabled]);

  // Toggle screen share
  const toggleScreenShare = useCallback(async () => {
    if (!room?.localParticipant) return;

    const isCurrentlySharing = room.localParticipant.isScreenShareEnabled;

    if (isCurrentlySharing) {
      await room.localParticipant.setScreenShareEnabled(false);
      setScreenSharing(false);
    } else {
      try {
        await room.localParticipant.setScreenShareEnabled(true);
        setScreenSharing(true);
      } catch (error) {
        if (error instanceof Error && error.message.includes('Permission denied')) {
          // User cancelled screen share picker
          console.log('Screen share cancelled');
        } else {
          toast.error('Failed to start screen share');
        }
      }
    }
  }, [room, setScreenSharing]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (roomRef.current) {
        roomRef.current.disconnect();
      }
    };
  }, []);

  return {
    connect,
    disconnect,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
  };
}
