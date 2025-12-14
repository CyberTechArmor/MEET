import { useState, useEffect, useCallback } from 'react';

interface MediaDeviceInfo {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

interface MediaDevices {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
}

export function useMediaDevices() {
  const [devices, setDevices] = useState<MediaDevices>({
    audioInputs: [],
    videoInputs: [],
    audioOutputs: [],
  });
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshDevices = useCallback(async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();

      const audioInputs = allDevices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 4)}`,
          kind: d.kind,
        }));

      const videoInputs = allDevices
        .filter((d) => d.kind === 'videoinput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${d.deviceId.slice(0, 4)}`,
          kind: d.kind,
        }));

      const audioOutputs = allDevices
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Speaker ${d.deviceId.slice(0, 4)}`,
          kind: d.kind,
        }));

      setDevices({ audioInputs, videoInputs, audioOutputs });

      // Check if we have permission (labels are only available with permission)
      const hasLabels = allDevices.some((d) => d.label !== '');
      setHasPermission(hasLabels);

    } catch (error) {
      console.error('Failed to enumerate devices:', error);
      setHasPermission(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });

      // Stop all tracks immediately
      stream.getTracks().forEach((track) => track.stop());

      setHasPermission(true);
      await refreshDevices();
      return true;

    } catch (error) {
      console.error('Permission denied:', error);
      setHasPermission(false);
      return false;
    }
  }, [refreshDevices]);

  useEffect(() => {
    refreshDevices();

    // Listen for device changes
    const handleDeviceChange = () => {
      refreshDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [refreshDevices]);

  return {
    devices,
    hasPermission,
    isLoading,
    refreshDevices,
    requestPermissions,
  };
}
