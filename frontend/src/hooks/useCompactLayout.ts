import { useEffect, useState } from 'react';

// "Compact" = the app is running in a small window: a picture-in-picture
// style floating window, a narrow sidebar, or a phone held sideways. In
// that mode the room shows only what matters (the other person, or the
// shared screen), drops the self view / room badge, and uses small icons.
const COMPACT_MAX_WIDTH = 640;
const COMPACT_MAX_HEIGHT = 480;

function measure(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < COMPACT_MAX_WIDTH || window.innerHeight < COMPACT_MAX_HEIGHT;
}

export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState<boolean>(measure);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setCompact(measure()));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    onResize();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return compact;
}
