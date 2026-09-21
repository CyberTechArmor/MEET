// Embed messaging bridge.
//
// When MEET runs inside an iframe, the host page can drive it and follow
// it WITHOUT touching the iframe's DOM (moving or re-mounting an iframe
// reloads it, which ends the call and any screen share). The same bridge
// serves a host that opens MEET in a popup window instead of framing it —
// there the events go to window.opener. Everything goes
// over window.postMessage:
//
//   host ← MEET   { source: 'meet', type: 'meet:joined', ... }
//   host → MEET   iframe.contentWindow.postMessage({ type: 'meet:leave' }, '*')
//
// Messages are plain JSON. Payloads never include tokens or credentials,
// so events are posted with targetOrigin '*'. Commands are accepted from
// any origin — the embedding page already controls the iframe element.

export type HostEvent =
  | { type: 'meet:ready'; embed: boolean; room: string | null; version: string }
  | { type: 'meet:joining'; room: string; name: string }
  | { type: 'meet:joined'; room: string; identity: string; name: string; isHost: boolean; joinedAt: number }
  | { type: 'meet:reconnecting'; room: string }
  | { type: 'meet:left'; room: string; reason: LeftReason; willRejoin: boolean }
  | { type: 'meet:participants'; room: string; count: number; participants: Array<{ identity: string; name: string }> }
  | { type: 'meet:screenshare'; room: string; active: boolean; by: string | null; local: boolean }
  | { type: 'meet:media'; room: string; audio: boolean; video: boolean }
  | { type: 'meet:layout'; compact: boolean }
  | { type: 'meet:pip'; open: boolean }
  | { type: 'meet:error'; command: string; message: string }
  | { type: 'meet:state'; state: Record<string, unknown> };

export type LeftReason =
  | 'left'            // the participant pressed Leave
  | 'ended'           // the meeting was ended for everyone
  | 'removed'         // removed by a host
  | 'duplicate'       // the same window identity joined elsewhere
  | 'connection-lost' // network / server; MEET will try to rejoin
  | 'unknown';

export type HostCommand =
  | { type: 'meet:leave' }
  | { type: 'meet:end' }                                   // host only
  | { type: 'meet:mute'; audio?: boolean; video?: boolean } // true = muted
  | { type: 'meet:screenshare'; enabled: boolean }          // start needs a click inside MEET
  | { type: 'meet:compact'; mode: 'auto' | 'on' | 'off' }
  | { type: 'meet:hideEndCall'; hide: boolean }
  | { type: 'meet:pip'; open?: boolean }
  | { type: 'meet:fullscreen'; enter?: boolean }
  | { type: 'meet:get-state' };

export function isFramed(): boolean {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * The window driving this one, if any: the embedding page when MEET is in an
 * iframe, otherwise the page that opened it with window.open().
 *
 * A popup is how a host gets MEET's own Document Picture-in-Picture — that
 * needs a top-level page, so it is unavailable in a frame — and a host that
 * pops the call out still wants to know when it joined, reconnected or left.
 * `window.parent` is the window itself outside a frame, so events have to go
 * to the opener there or they go nowhere at all.
 */
export function hostWindow(): Window | null {
  try {
    if (typeof window === 'undefined') return null;
    if (isFramed()) return window.parent;
    const opener = window.opener as Window | null;
    // `closed` is readable cross-origin; a closed opener cannot receive anything.
    return opener && !opener.closed ? opener : null;
  } catch {
    return null;
  }
}

/** True when some page is driving MEET — embedded in a frame or opened as a popup. */
export function isHosted(): boolean {
  return hostWindow() !== null;
}

/** Post an event to the host page. No-op when nothing is hosting MEET. */
export function postToHost(event: HostEvent): void {
  const target = hostWindow();
  if (!target) return;
  try {
    target.postMessage({ source: 'meet', ...event }, '*');
  } catch (e) {
    console.warn('embed bridge: postMessage failed', e);
  }
}

/** Subscribe to host commands. Returns an unsubscribe function. */
export function onHostCommand(handler: (cmd: HostCommand, event: MessageEvent) => void): () => void {
  const listener = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (!data.type.startsWith('meet:')) return;
    // Ignore our own events echoed back by a host that re-broadcasts.
    if (data.source === 'meet') return;
    handler(data as HostCommand, event);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
