import { SAMPLE_INTERVAL_MS } from '@ralphralphai/schema';
import type React from 'react';
import { useEffect, useRef } from 'react';

import { Tracker, type TrackerConfig } from '@/tracker';

/** How often buffered events are offered to the transport. */
const SEND_INTERVAL_MS = 3000;

/**
 * Mount once near the app root. Attaches the global listeners and periodically
 * offers buffered events to the injected transport.
 */
export const GlobalTracker: React.FC<TrackerConfig> = (config) => {
  const trackerRef = useRef<Tracker | null>(null);

  useEffect(() => {
    // Construct on the client only: the tracker reads storage and `window`, and
    // this component is server-rendered by Next.js on first load. The ref keeps
    // the instance (and its buffered SessionStart) across StrictMode's dev
    // remount, so the session-start event is not dropped.
    const tracker =
      trackerRef.current ?? (trackerRef.current = new Tracker(config));

    if (!tracker.enabled) {
      return;
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        tracker.onPageLeave();
      }
    };

    document.addEventListener('click', tracker.trackClick, { capture: true });
    window.addEventListener('pointermove', tracker.trackPointerMove, {
      passive: true,
    });
    window.addEventListener('pagehide', tracker.onPageLeave);
    window.addEventListener('visibilitychange', onVisibilityChange);

    const pageViewInterval = setInterval(
      tracker.trackPageView,
      SAMPLE_INTERVAL_MS,
    );
    const mouseMoveInterval = setInterval(
      tracker.trackMouseMove,
      SAMPLE_INTERVAL_MS,
    );
    const sendInterval = setInterval(tracker.sendToServer, SEND_INTERVAL_MS);

    return () => {
      document.removeEventListener('click', tracker.trackClick, {
        capture: true,
      });
      window.removeEventListener('pointermove', tracker.trackPointerMove);
      window.removeEventListener('pagehide', tracker.onPageLeave);
      window.removeEventListener('visibilitychange', onVisibilityChange);
      clearInterval(pageViewInterval);
      clearInterval(mouseMoveInterval);
      clearInterval(sendInterval);
    };
  }, []);

  return <></>;
};
