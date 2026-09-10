import { useCallback, useEffect, useMemo } from 'react';
import { Track, type Participant, type RemoteParticipant, type LocalParticipant } from 'livekit-client';
import { useRoomStore } from '../stores/roomStore';
import { postToHost } from '../lib/embedBridge';

// MEET-native picture-in-picture.
//
// Opened FROM INSIDE MEET, so the iframe and the LiveKit connection stay
// exactly where they are: no reload, the screen share keeps running. The
// most relevant track (active screen share → first remote camera → own
// camera) is attached to a <video> and re-pointed whenever that changes.
//
// Two mechanisms, chosen at open time:
//  - Document Picture-in-Picture (Chromium 116+): a real always-on-top
//    window with a label. Browsers only allow it from a TOP-LEVEL page,
//    so it is used when MEET is not embedded.
//  - Video picture-in-picture (Chrome, Edge, Safari): the browser's
//    floating video of a single <video> element. Works inside an iframe
//    that has allow="picture-in-picture"; used when embedded.
// Both need a user gesture inside MEET (a click on the button).

function isFramed(): boolean {
  try { return window.self !== window.top; } catch { return true; }
}

export function isDocumentPipSupported(): boolean {
  return typeof window !== 'undefined' && !!window.documentPictureInPicture && !isFramed();
}

export function isVideoPipSupported(): boolean {
  return typeof document !== 'undefined' && !!document.pictureInPictureEnabled
    && typeof HTMLVideoElement !== 'undefined' && 'requestPictureInPicture' in HTMLVideoElement.prototype;
}

export function isPipSupported(): boolean {
  return isDocumentPipSupported() || isVideoPipSupported();
}

interface Chosen {
  track: Track | null;
  label: string;
  mirror: boolean;
}

function chooseTrack(): Chosen {
  const { localParticipant, remoteParticipants, activeScreenShareIdentity } = useRoomStore.getState();
  const all: Participant[] = [...remoteParticipants, ...(localParticipant ? [localParticipant] : [])];

  // 1. active screen share (last sharer wins), local or remote
  const sharer = all.find((p) => p.identity === activeScreenShareIdentity)
    ?? all.find((p) => {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      return pub?.track && !pub.isMuted;
    });
  if (sharer) {
    const pub = sharer.getTrackPublication(Track.Source.ScreenShare);
    if (pub?.track && !pub.isMuted) {
      const local = sharer === localParticipant;
      return { track: pub.track, label: local ? 'Your screen' : `${sharer.name || sharer.identity}'s screen`, mirror: false };
    }
  }
  // 2. first remote camera
  for (const r of remoteParticipants as RemoteParticipant[]) {
    const pub = r.getTrackPublication(Track.Source.Camera);
    if (pub?.track && !pub.isMuted) return { track: pub.track, label: r.name || r.identity, mirror: false };
  }
  if (remoteParticipants.length > 0) {
    const r = remoteParticipants[0];
    return { track: null, label: `${r.name || r.identity} (camera off)`, mirror: false };
  }
  // 3. own camera
  const lp = localParticipant as LocalParticipant | null;
  const pub = lp?.getTrackPublication(Track.Source.Camera);
  if (pub?.track && !pub.isMuted) return { track: pub.track, label: 'You', mirror: true };
  return { track: null, label: 'Waiting for others…', mirror: false };
}

// One PiP window per page, shared by every caller of the hook (the
// control-bar button and the embed bridge both drive the same window).
const winRef: { current: Window | null } = { current: null };
const videoRef: { current: HTMLVideoElement | null } = { current: null };
const labelRef: { current: HTMLDivElement | null } = { current: null };
const attachedRef: { current: Track | null } = { current: null };
// Video-PiP mode: the hidden <video> in the main document that the
// browser's floating window mirrors.
const videoPipRef: { current: HTMLVideoElement | null } = { current: null };

export function useDocumentPip() {
  const setPipOpen = useRoomStore((s) => s.setPipOpen);
  const pipOpen = useRoomStore((s) => s.pipOpen);

  const refresh = useCallback(() => {
    const video = videoRef.current;
    if (!video || (!winRef.current && !videoPipRef.current)) return;
    const { track, label, mirror } = chooseTrack();
    if (labelRef.current) labelRef.current.textContent = label;
    video.style.transform = mirror ? 'scaleX(-1)' : '';
    if (attachedRef.current === track) return;
    if (attachedRef.current) {
      try { attachedRef.current.detach(video); } catch { /* ignore */ }
    }
    attachedRef.current = track;
    if (track) {
      track.attach(video);
    } else {
      video.srcObject = null;
    }
  }, []);

  const close = useCallback(() => {
    const win = winRef.current;
    winRef.current = null;
    if (attachedRef.current && videoRef.current) {
      try { attachedRef.current.detach(videoRef.current); } catch { /* ignore */ }
    }
    attachedRef.current = null;
    videoRef.current = null;
    labelRef.current = null;
    try { win?.close(); } catch { /* ignore */ }
    const vp = videoPipRef.current;
    videoPipRef.current = null;
    if (vp) {
      if (document.pictureInPictureElement === vp) {
        document.exitPictureInPicture().catch(() => { /* ignore */ });
      }
      vp.remove();
    }
    setPipOpen(false);
    postToHost({ type: 'meet:pip', open: false });
  }, [setPipOpen]);

  // Browser video PiP: a hidden <video> in this document mirrored by the
  // browser's floating window. Used when embedded (Document PiP is
  // top-level only) or where Document PiP doesn't exist.
  const openVideoPip = useCallback(async () => {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
    document.body.appendChild(video);
    videoPipRef.current = video;
    videoRef.current = video;
    labelRef.current = null;
    refresh();
    if (!attachedRef.current) {
      video.remove();
      videoPipRef.current = null;
      videoRef.current = null;
      throw new Error('Nothing to show in picture-in-picture yet');
    }
    video.addEventListener('leavepictureinpicture', () => {
      if (videoPipRef.current === video) close();
    });
    try {
      await video.play().catch(() => { /* autoplay may resolve later */ });
      await video.requestPictureInPicture();
    } catch (e) {
      close();
      throw e;
    }
    setPipOpen(true);
    postToHost({ type: 'meet:pip', open: true });
  }, [refresh, close, setPipOpen]);

  const open = useCallback(async () => {
    if (winRef.current || videoPipRef.current) return;
    if (!isDocumentPipSupported()) {
      if (!isVideoPipSupported()) throw new Error('Picture-in-picture is not supported in this browser');
      await openVideoPip();
      return;
    }
    const win = await window.documentPictureInPicture!.requestWindow({ width: 420, height: 260 });
    winRef.current = win;
    const doc = win.document;
    doc.title = 'MEET';
    const style = doc.createElement('style');
    style.textContent = `
      html, body { margin: 0; height: 100%; background: #0a0a0a; color: #e5e7eb; font: 13px -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; overflow: hidden; }
      video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }
      .label { position: absolute; left: 10px; bottom: 8px; padding: 3px 8px; border-radius: 6px; background: rgba(0,0,0,.55); }
      .wrap { position: relative; width: 100%; height: 100%; }
    `;
    doc.head.appendChild(style);
    const wrap = doc.createElement('div');
    wrap.className = 'wrap';
    const video = doc.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // audio keeps playing in the main window
    const label = doc.createElement('div');
    label.className = 'label';
    wrap.appendChild(video);
    wrap.appendChild(label);
    doc.body.appendChild(wrap);
    videoRef.current = video;
    labelRef.current = label;
    win.addEventListener('pagehide', () => {
      if (winRef.current === win) {
        winRef.current = null;
        attachedRef.current = null;
        videoRef.current = null;
        labelRef.current = null;
        setPipOpen(false);
        postToHost({ type: 'meet:pip', open: false });
      }
    });
    setPipOpen(true);
    postToHost({ type: 'meet:pip', open: true });
    refresh();
  }, [refresh, setPipOpen, openVideoPip]);

  const toggle = useCallback(async () => {
    if (winRef.current || videoPipRef.current) close();
    else await open();
  }, [open, close]);

  // Re-point the PiP video whenever tracks / participants change.
  useEffect(() => {
    if (!pipOpen) return;
    const unsub = useRoomStore.subscribe(() => refresh());
    const interval = window.setInterval(refresh, 1500); // mute/unmute don't always hit the store
    return () => { unsub(); window.clearInterval(interval); };
  }, [pipOpen, refresh]);

  // Close the PiP window when the call ends.
  const view = useRoomStore((s) => s.view);
  useEffect(() => {
    if (view !== 'room' && (winRef.current || videoPipRef.current)) close();
  }, [view, close]);

  return useMemo(
    () => ({ supported: isPipSupported(), open, close, toggle, isOpen: pipOpen }),
    [open, close, toggle, pipOpen],
  );
}
