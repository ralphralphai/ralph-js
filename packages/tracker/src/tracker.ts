import {
  type BatchIdentity,
  type EventBatch,
  encodeBatch,
  MAX_REFERRER_LENGTH,
  MOUSE_GRID_PX,
  quantizeMouse,
  type RawEvent,
  type TagValue,
  type ViewportSize,
} from '@ralphralphai/schema';

import { BUTTON_TRACK_ID } from '@/ButtonWrapper';
import { sameTags, type TagStore, tagStore } from '@/tags';

/** Flush once this many events are buffered. */
const FLUSH_AT_EVENTS = 100;

/**
 * Flush at least this often while events are buffered.
 *
 * A visit that never fills the buffer would otherwise reach the server only in
 * the flush on hide, which is the one most likely to be lost.
 */
const MAX_SEND_GAP_MS = 60 * 1000;

/** `localStorage` key holding the anonymous, cross-session user id. */
const USER_ID_KEY = 'ralph.uid';

/** `sessionStorage` key holding the per-tab session id. */
const SESSION_ID_KEY = 'ralph.sid';

/** `sessionStorage` key holding when the session last saw activity, epoch ms. */
const LAST_ACTIVITY_KEY = 'ralph.sat';

/**
 * Inactivity after which the next activity starts a new session.
 *
 * Kept equal to the server's `IDLE_GRACE`, which closes a session after the same
 * quiet period: a shorter value here would split sessions the server still
 * holds open, a longer one would continue sessions the server already built.
 */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * Pointer movement reports activity many times a second, and each report
 * would otherwise be a synchronous storage write.
 */
const ACTIVITY_PERSIST_INTERVAL_MS = 1000;

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
 * Returns `null` when storage or UUID generation is unavailable. Safari in
 * Lockdown Mode and private-mode quota errors both throw on access rather than
 * returning null.
 */
const persistentId = (storage: Storage | undefined, key: string) => {
  return readItem(storage, key) ?? createId(storage, key);
};

const createId = (storage: Storage | undefined, key: string) => {
  if (!storage) {
    return null;
  }

  try {
    const created = crypto.randomUUID();
    return writeItem(storage, key, created) ? created : null;
  } catch {
    return null;
  }
};

const readItem = (storage: Storage | undefined, key: string) => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const writeItem = (
  storage: Storage | undefined,
  key: string,
  value: string,
): boolean => {
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
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

  private identity: BatchIdentity | null;

  private readonly sessionStore: Storage | undefined;

  private lastActivityAt: number;

  private persistedActivityAt: number;

  /** `null` until this page load's first batch is sent. */
  private lastSentAt: number | null = null;

  private started = false;

  constructor(
    private readonly config: TrackerConfig,
    /** The pending buffer. Injectable so tests can observe what was recorded. */
    private buffer: RawEvent[] = [],
    private readonly tags: TagStore = tagStore,
  ) {
    // `GlobalTracker` is a client component, but Next.js still server-renders it
    // on first load, where neither storage exists. Tracking is client-only, so
    // this no-ops on the server instead of crashing SSR.
    const local = safeStorage(() => localStorage);
    this.sessionStore = safeStorage(() => sessionStorage);

    const now = Date.now();
    this.lastActivityAt = now;
    this.persistedActivityAt = now;

    const userId = persistentId(local, USER_ID_KEY);
    const existingSession = readItem(this.sessionStore, SESSION_ID_KEY);

    const continuing =
      existingSession !== null &&
      !isIdleSince(readItem(this.sessionStore, LAST_ACTIVITY_KEY), now);

    const sessionId = continuing
      ? existingSession
      : createId(this.sessionStore, SESSION_ID_KEY);

    if (!userId || !sessionId) {
      this.identity = null;
      return;
    }

    // A fresh session id means this is the session's first page.
    const referrer = continuing ? undefined : landingReferrer();

    this.identity = {
      userId,
      sessionId,
      ...(config.buildId === undefined ? {} : { buildId: config.buildId }),
      ...(referrer === undefined ? {} : { referrer }),
    };

    writeItem(this.sessionStore, LAST_ACTIVITY_KEY, String(now));

    if (!continuing) {
      this.buffer.push({ ty: 6, at: now });
    }

    window.__ralphTags = () => this.tags.at(window.location.href);
  }

  /** Whether the tracker found the storage it needs to identify a session. */
  get enabled(): boolean {
    return this.identity !== null;
  }

  /** Number of buffered events. Exposed for tests. */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Send `SessionStart` and the landing page view the moment the page mounts.
   *
   * `keepalive` makes the transport send plain JSON synchronously, and lets the
   * request outlive a page closed right after loading, so a visit of any length
   * registers. Idempotent because StrictMode mounts the tracker twice in dev.
   */
  start = (): void => {
    if (this.started) {
      return;
    }

    this.started = true;
    this.trackPageView();
    void this.flush({ keepalive: true });
  };

  /**
   * The first offer sends whatever is buffered, so even a visit that ends
   * seconds later has already registered its session and landing page.
   */
  sendToServer = async (): Promise<void> => {
    const due =
      this.lastSentAt === null ||
      this.buffer.length >= FLUSH_AT_EVENTS ||
      Date.now() - this.lastSentAt >= MAX_SEND_GAP_MS;

    if (!due) {
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
    this.lastSentAt = Date.now();
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
    this.markSessionAsActive(at);

    const url = window.location.href;
    const tags = this.tagsAt(url);

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
      ...tags,
    });
  };

  trackPageView = (): void => {
    // Skip while the tab is hidden. The interval keeps firing there, throttled,
    // so a tab left in the background would grow its run until the tab is
    // closed, stretching the session's end time by the hidden period.
    if (!this.identity || document.visibilityState !== 'visible') {
      return;
    }

    // Raw scroll offsets rather than the derived page centre: identical
    // information given the size is recorded, but `0` when unscrolled, so it
    // compresses and run-length-encodes far better.
    const url = window.location.href;
    const tags = this.tagsAt(url);
    const sample = {
      ty: 5,
      at: Date.now(),
      url,
      size: currentScreenSize(),
      sx: Math.round(window.scrollX),
      sy: Math.round(window.scrollY),
      ...tags,
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
    this.markSessionAsActive(Date.now());
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
    const url = window.location.href;
    const tags = this.tagsAt(url);
    const sample = {
      ty: 8,
      at: Date.now(),
      url,
      size: currentScreenSize(),
      px: quantizeMouse(position.clientX + window.scrollX),
      py: quantizeMouse(position.clientY + window.scrollY),
      ...tags,
    } as const satisfies RawEvent;

    this.pushSample(
      sample,
      (last) => last.px === sample.px && last.py === sample.py,
    );
  };

  onHide = (): void => {
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
      sameTags(last.visitorTags, sample.visitorTags) &&
      sameTags(last.pageTags, sample.pageTags) &&
      matches(last as T)
    ) {
      last.count = (last.count ?? 1) + 1;
      return;
    }

    // A folded sample is the page sitting still, which is not activity:
    // counting it would keep an idle open tab's session alive forever.
    this.markSessionAsActive(sample.at);
    this.buffer.push(sample);
  }

  private markSessionAsActive(at: number): void {
    const identity = this.identity;
    if (!identity) {
      return;
    }

    // If the session has been idle for too long previously, then rotate the session.
    if (at - this.lastActivityAt > SESSION_IDLE_MS) {
      this.rotateSession(identity, at);
    }

    this.lastActivityAt = at;

    if (at - this.persistedActivityAt >= ACTIVITY_PERSIST_INTERVAL_MS) {
      writeItem(this.sessionStore, LAST_ACTIVITY_KEY, String(at));
      this.persistedActivityAt = at;
    }
  }

  private rotateSession(previous: BatchIdentity, at: number): void {
    // `flush` encodes before its first await, so the buffered events still go
    // out under the session they were recorded in.
    void this.flush({ keepalive: false });

    // Kept in memory even when storage refuses the write: this page load stays
    // on the new session either way.
    const sessionId = crypto.randomUUID();
    writeItem(this.sessionStore, SESSION_ID_KEY, sessionId);

    this.identity = {
      userId: previous.userId,
      sessionId,
      ...(previous.buildId === undefined ? {} : { buildId: previous.buildId }),
    };
    this.buffer.push({ ty: 6, at });
  }

  private tagsAt(url: string): {
    visitorTags?: Record<string, TagValue>;
    pageTags?: Record<string, TagValue>;
  } {
    const { visitorTags, pageTags } = this.tags.at(url);
    return {
      ...(Object.keys(visitorTags).length === 0 ? {} : { visitorTags }),
      ...(Object.keys(pageTags).length === 0 ? {} : { pageTags }),
    };
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

const isIdleSince = (lastActivityAt: string | null, now: number): boolean => {
  // A session stored without a timestamp predates idle rotation. Treating it as
  // active keeps an SDK upgrade from splitting every open session.
  if (lastActivityAt === null) {
    return false;
  }

  return now - Number(lastActivityAt) > SESSION_IDLE_MS;
};

const landingReferrer = (): string | undefined => {
  const referrer = document.referrer;
  if (referrer === '' || referrer.length > MAX_REFERRER_LENGTH) {
    return undefined;
  }

  return referrer;
};

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

export { FLUSH_AT_EVENTS, MAX_SEND_GAP_MS, MOUSE_GRID_PX };
