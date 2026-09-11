/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LIVEKIT_URL: string;
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Document Picture-in-Picture (Chromium 116+). Not yet in lib.dom.
interface DocumentPictureInPictureWindowOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  preferInitialWindowPlacement?: boolean;
}
interface DocumentPictureInPicture extends EventTarget {
  readonly window: Window | null;
  requestWindow(options?: DocumentPictureInPictureWindowOptions): Promise<Window>;
}
interface Window {
  documentPictureInPicture?: DocumentPictureInPicture;
}
