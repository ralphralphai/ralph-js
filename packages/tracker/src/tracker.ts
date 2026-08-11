import {
  type BatchIdentity,
  type EventBatch,
  encodeBatch,
  MOUSE_GRID_PX,
  quantizeMouse,
  type RawEvent,
  type ViewportSize,
} from '@ralphralphai/schema';

import { BUTTON_TRACK_ID } from '@/ButtonWrapper';

/** Flush once this many events are buffered. */
const FLUSH_AT_EVENTS = 100;

/** `localStorage` key holding the anonymous, cross-session user id. */
const USER_ID_KEY = 'ralph.uid';

/** `sessionStorage` key holding the per-tab session id. */
const SESSION_ID_KEY = 'ralph.sid';

/**
 * Where a batch goes. Injected rather than baked in, so the SDK carries no
 * transport opinion and tests can assert on the batch itself.
 */
export type SendBatch = (
  batch: EventBatch,
  options: { keepalive: boolean },
) => void | Promise<void>;

export type TrackerConfig = {
  sendBatch: SendBatch;
  /** Identifies the deploy the events were recorded against. */
  buildId?: string;
};

const currentScreenSize = (): ViewportSize => [
  // The visual viewport is more accurate on mobile: it excludes the address bar
  // and the keyboard.
  Math.round(window.visualViewport?.width ?? window.innerWidth),
  Math.round(window.visualViewport?.height ?? window.innerHeight),
];

/**
 * Read a stable id from storage, creating one on first use.
 *
 * Returns `null` when storage is unavailable. Safari in Lockdown Mode and
 * private-mode quota errors both throw on access rather than returning null.
 */
const persistentId = (storage: Storage | undefined, key: string) => {
  if (!storage) {
    return null;
  }

  try {
    const existing = storage.getItem(key);
    if (existing) {
      return existing;
    }

    const created = crypto.randomUUID();
    storage.setItem(key, created);
    return created;
  } catch {
    return null;
  }
};

const safeStorage = (get: () => Storage): Storage | undefined => {
  try {
    return get();
  } catch {
    return undefined;
  }
};

/**
 * Buffers interaction samples and flushes them as columnar batches.
 *
 * The tracker produces `RawEvent`s, semantic samples carrying full urls and
 * sizes, and hands them to `@ralphralphai/schema`'s encoder, which owns the lookup
 * tables, delta timestamps, and the transposition. Nothing here knows the wire
 * layout.
 */
export class Tracker {
  /**
   * The last pointer position, kept viewport-relative so sampling can combine it
   * with the current scroll offset even when scrolling emits no pointermove.
   */
  private latestPointerPosition: { clientX: number; clientY: number } | null =
    null;

  private readonly identity: BatchIdentity | null;

  constructor(
    private readonly config: TrackerConfig,
    /** The pending buffer. Injectable so tests can observe what was recorded. */
    private buffer: RawEvent[] = [],
  ) {
    // `GlobalTracker` is a client component, but Next.js still server-renders it
    // on first load, where neither storage exists. Tracking is client-only, so
    // this no-ops on the server instead of crashing SSR.
    const local = safeStorage(() => localStorage);
    const session = safeStorage(() => sessionStorage);

    const userId = persistentId(local, USER_ID_KEY);
    const existingSession = (() => {
      try {
        return session?.getItem(SESSION_ID_KEY) ?? null;
      } catch {
        return null;
      }
    })();
    const sessionId = persistentId(session, SESSION_ID_KEY);

    if (!userId || !sessionId) {
      this.identity = null;
      return;
    }

    this.identity = {
      userId,
      sessionId,
      ...(config.buildId === undefined ? {} : { buildId: config.buildId }),
    };

    // A fresh session id means this is the session's first page.
    if (!existingSession) {
      this.buffer.push({ ty: 6, at: Date.now() });
    }
  }

  /** Whether the tracker found the storage it needs to identify a session. */
  get enabled(): boolean {
    return this.identity !== null;
  }

  /** Number of buffered events. Exposed for tests. */
  get pending(): number {
    return this.buffer.length;
  }

  sendToServer = async (): Promise<void> => {
    if (this.buffer.length < FLUSH_AT_EVENTS) {
      return;
    }
    await this.flush({ keepalive: false });
  };

  /** Send everything buffered, whatever the count. */
  flush = async (options: { keepalive: boolean }): Promise<void> => {
    const identity = this.identity;
    if (!identity || this.buffer.length === 0) {
      return;
    }

    const events = this.buffer.splice(0, this.buffer.length);
    await this.config.sendBatch(encodeBatch(identity, events), options);
  };

  trackClick = (event: MouseEvent): void => {
    if (!this.identity || !(event.target instanceof Element)) {
      return;
    }

    const actionable = event.target.closest(
      `[${BUTTON_TRACK_ID}], button, a[href], [role='button'], input, select, textarea`,
    );
    const trackId = actionable?.getAttribute(BUTTON_TRACK_ID) ?? undefined;

    const at = Date.now();
    const url = window.location.href;

    // Emitted back to back with the PageClick below, at the same millisecond and
    // for the same url, which is why `Pressable` carries no url of its own.
    if (trackId) {
      this.buffer.push({ ty: 1, at, trackId });
    }

    // Page-absolute only, because that is all anything reads: the aggregator
    // uses the page-absolute position, and a viewport-relative pair is derivable
    // as `pageX - scrollX` anyway.
    //
    // There is no `textContent` either. It had no readers, ran to 100 characters
    // per click, and captured rendered page text, which is a PII leak.
    this.buffer.push({
      ty: 4,
      at,
      url,
      size: currentScreenSize(),
      px: Math.round(event.pageX),
      py: Math.round(event.pageY),
      ...(actionable && trackId
        ? { trackId, ...relativeTo(actionable, event) }
        : {}),
    });
  };

  trackPageView = (): void => {
    if (!this.identity) {
      return;
    }

    // Raw scroll offsets rather than the derived page centre: identical
    // information given the size is recorded, but `0` when unscrolled, so it
    // compresses and run-length-encodes far better.
    const sample = {
      ty: 5,
      at: Date.now(),
      url: window.location.href,
      size: currentScreenSize(),
      sx: Math.round(window.scrollX),
      sy: Math.round(window.scrollY),
    } as const satisfies RawEvent;

    this.pushSample(
      sample,
      (last) => last.sx === sample.sx && last.sy === sample.sy,
    );
  };

  /**
   * Only mouse and pen movement is a useful pointer signal. Finger touches also
   * emit pointermove, but they track scrolling rather than intent.
   */
  trackPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') {
      return;
    }

    this.latestPointerPosition = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
  };

  trackMouseMove = (): void => {
    const position = this.latestPointerPosition;

    // Skip while the tab is hidden: pointermove does not fire there, so the
    // stored position is stale and would inflate a resting-cursor run.
    if (!this.identity || !position || document.visibilityState !== 'visible') {
      return;
    }

    // Quantized to the grid the server buckets to anyway, and quantized *before*
    // the equality test below. Runs are compared exactly, so 1 px of jitter would
    // otherwise defeat them. That costs more than bytes: it multiplies the event
    // count by up to 30x, and with it the request and batch-row counts.
    const sample = {
      ty: 8,
      at: Date.now(),
      url: window.location.href,
      size: currentScreenSize(),
      px: quantizeMouse(position.clientX + window.scrollX),
      py: quantizeMouse(position.clientY + window.scrollY),
    } as const satisfies RawEvent;

    this.pushSample(
      sample,
      (last) => last.px === sample.px && last.py === sample.py,
    );
  };

  onPageLeave = (): void => {
    if (!this.identity) {
      return;
    }

    this.buffer.push({ ty: 7, at: Date.now() });

    // `keepalive` caps the body at 64 KB, a real truncation risk on the exact
    // flush where SessionEnd matters most. A gzipped columnar batch is roughly an
    // order of magnitude smaller, so a capped flush does not reach that cap in
    // practice.
    void this.flush({ keepalive: true });
  };

  /**
   * Append a sampled event, or extend the previous run.
   *
   * `PageView` and `MouseMove` are sampled on a fixed cadence, so consecutive
   * identical samples fold into one event with a count. The win is the event
   * count, which gates flush frequency, request count, batch rows, and rollup
   * work. On bytes it wins almost nothing, since gzip already collapses runs.
   */
  private pushSample<T extends Extract<RawEvent, { count?: number }>>(
    sample: T,
    matches: (last: T) => boolean,
  ): void {
    const last = this.lastSampleOfType(sample.ty);

    if (
      last &&
      last.url === sample.url &&
      last.size[0] === sample.size[0] &&
      last.size[1] === sample.size[1] &&
      matches(last as T)
    ) {
      last.count = (last.count ?? 1) + 1;
      return;
    }

    this.buffer.push(sample);
  }

  private lastSampleOfType(
    ty: 5 | 8,
  ): Extract<RawEvent, { ty: 5 | 8 }> | undefined {
    for (let index = this.buffer.length - 1; index >= 0; index--) {
      const event = this.buffer[index];
      if (event?.ty === ty) {
        return event;
      }
    }
    return undefined;
  }
}

/** A click's position relative to the tracked element it landed on. */
const relativeTo = (
  element: Element,
  event: MouseEvent,
): { rx: number; ry: number } => {
  const box = element.getBoundingClientRect();
  return {
    rx: Math.round(event.clientX - box.left),
    ry: Math.round(event.clientY - box.top),
  };
};

export { FLUSH_AT_EVENTS, MOUSE_GRID_PX };
