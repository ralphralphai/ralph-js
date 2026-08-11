import type { EventBatch, RawEvent } from '@ralphralphai/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Tracker } from '@/tracker';

const URL = 'https://example.com/pricing';

// The tracker reads storage, `window`, `document` and `crypto`. Stubbing them is
// cheaper than a full DOM implementation, and it keeps the assertions about what
// the tracker records rather than about how jsdom behaves.
beforeEach(() => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };

  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('crypto', {
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
  });
  vi.stubGlobal('window', {
    innerWidth: 1200,
    innerHeight: 800,
    location: { href: URL },
    scrollX: 0,
    scrollY: 100,
  });
  vi.stubGlobal('document', { visibilityState: 'visible' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

class TestElement {
  constructor(private closestElement?: TestElement) {}
  closest = () => this.closestElement ?? null;
  getAttribute = (_attribute: string): string | null => null;
  getBoundingClientRect = () => ({ left: 0, top: 0 });
}

const stubElementGlobal = () => vi.stubGlobal('Element', TestElement);

describe('session identity', () => {
  it('emits SessionStart on a fresh session only', () => {
    const first: RawEvent[] = [];
    new Tracker({ sendBatch: vi.fn() }, first);
    expect(first.map((e) => e.ty)).toEqual([6]);

    // Second construction in the same tab: the session id is already stored.
    const second: RawEvent[] = [];
    new Tracker({ sendBatch: vi.fn() }, second);
    expect(second).toEqual([]);
  });

  it('disables itself when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('sessionStorage', undefined);

    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);

    expect(tracker.enabled).toBe(false);
    tracker.trackPageView();
    expect(buffer).toEqual([]);
  });
});

describe('clicks', () => {
  it('records a tracked click as Pressable plus PageClick', () => {
    stubElementGlobal();

    const button = new TestElement();
    button.getAttribute = (attribute) =>
      attribute === 'data-track-id' ? 'cta.signup' : null;
    button.getBoundingClientRect = () => ({ left: 10, top: 20 });

    // A click landing on an SVG inside the button still attributes to it.
    const target = new TestElement(button);
    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    tracker.trackClick({
      target,
      clientX: 15,
      clientY: 25,
      pageX: 15,
      pageY: 125,
    } as unknown as MouseEvent);

    expect(buffer).toEqual([
      // Carries no url of its own: the PageClick beside it has the same one at
      // the same millisecond.
      { ty: 1, at: expect.any(Number), trackId: 'cta.signup' },
      {
        ty: 4,
        at: expect.any(Number),
        url: URL,
        size: [1200, 800],
        px: 15,
        py: 125,
        trackId: 'cta.signup',
        rx: 5,
        ry: 5,
      },
    ]);
  });

  it('records an untracked click without tr, rx or ry', () => {
    stubElementGlobal();

    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    tracker.trackClick({
      target: new TestElement(),
      clientX: 3,
      clientY: 4,
      pageX: 3,
      pageY: 104,
    } as unknown as MouseEvent);

    expect(buffer).toEqual([
      {
        ty: 4,
        at: expect.any(Number),
        url: URL,
        size: [1200, 800],
        px: 3,
        py: 104,
      },
    ]);
  });

  it('records no textContent', () => {
    stubElementGlobal();

    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    tracker.trackClick({
      target: new TestElement(),
      clientX: 0,
      clientY: 0,
      pageX: 0,
      pageY: 0,
    } as unknown as MouseEvent);

    // It had no readers, ran to 100 characters per click, and captured rendered
    // page text, which is a PII leak.
    expect(JSON.stringify(buffer)).not.toContain('textContent');
  });
});

describe('pointer sampling', () => {
  const move = (tracker: Tracker, clientX: number, clientY: number) => {
    tracker.trackPointerMove({
      pointerType: 'mouse',
      clientX,
      clientY,
    } as PointerEvent);
    tracker.trackMouseMove();
  };

  it('quantizes to the 5px grid', () => {
    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    move(tracker, 102, 3);

    expect(buffer).toEqual([
      {
        ty: 8,
        at: expect.any(Number),
        url: URL,
        size: [1200, 800],
        px: 100,
        py: 105, // 3 + scrollY 100 = 103, snapped to 105
      },
    ]);
  });

  it('folds jitter within one grid cell into a run instead of new events', () => {
    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    // Comparing positions for exact equality means 1px of jitter would defeat
    // the run, which multiplies the event count, and with it the request count.
    move(tracker, 200, 200);
    move(tracker, 201, 199);
    move(tracker, 200, 201);

    expect(buffer).toHaveLength(1);
    expect(buffer[0]).toMatchObject({ ty: 8, px: 200, py: 300, count: 3 });
  });

  it('starts a new event once the pointer leaves the cell', () => {
    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    move(tracker, 200, 200);
    move(tracker, 220, 200);

    expect(buffer.map((e) => 'px' in e && e.px)).toEqual([200, 220]);
  });

  it('ignores touch pointers', () => {
    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    tracker.trackPointerMove({
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    } as PointerEvent);
    tracker.trackMouseMove();

    expect(buffer).toEqual([]);
  });

  it('does not sample while the tab is hidden', () => {
    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    tracker.trackPointerMove({
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10,
    } as PointerEvent);
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    tracker.trackMouseMove();

    expect(buffer).toEqual([]);
  });
});

describe('page views', () => {
  it('records raw scroll offsets rather than a derived centre', () => {
    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    tracker.trackPageView();

    expect(buffer).toEqual([
      {
        ty: 5,
        at: expect.any(Number),
        url: URL,
        size: [1200, 800],
        sx: 0,
        sy: 100,
      },
    ]);
  });

  it('folds a stationary view into a run', () => {
    const buffer: RawEvent[] = [];
    const tracker = new Tracker({ sendBatch: vi.fn() }, buffer);
    buffer.length = 0;

    tracker.trackPageView();
    tracker.trackPageView();
    tracker.trackPageView();

    expect(buffer).toHaveLength(1);
    expect(buffer[0]).toMatchObject({ ty: 5, count: 3 });
  });
});

describe('flushing', () => {
  it('waits for the buffer threshold', async () => {
    const sent: { batch: EventBatch; keepalive: boolean }[] = [];
    const buffer: RawEvent[] = [];
    const tracker = new Tracker(
      {
        sendBatch: (batch, { keepalive }) =>
          void sent.push({ batch, keepalive }),
      },
      buffer,
    );

    // Drop the SessionStart construction records, so the count below is exactly
    // the threshold.
    buffer.length = 0;

    await tracker.sendToServer();
    expect(sent).toHaveLength(0);

    for (let i = 0; i < 100; i++) {
      buffer.push({ ty: 6, at: 1000 + i });
    }
    await tracker.sendToServer();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.keepalive).toBe(false);
    expect(sent[0]!.batch.n).toBe(100);
    expect(tracker.pending).toBe(0);
  });

  it('appends SessionEnd and flushes with keepalive on page leave', () => {
    const sent: { batch: EventBatch; keepalive: boolean }[] = [];
    const tracker = new Tracker({
      sendBatch: (batch, { keepalive }) => void sent.push({ batch, keepalive }),
    });

    tracker.onPageLeave();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.keepalive).toBe(true);
    // SessionStart from construction, then SessionEnd.
    expect(sent[0]!.batch.cols.ty).toEqual([6, 7]);
  });

  it('produces a batch the server would accept', () => {
    const sent: { batch: EventBatch; keepalive: boolean }[] = [];
    const buffer: RawEvent[] = [];
    const tracker = new Tracker(
      {
        sendBatch: (batch, { keepalive }) =>
          void sent.push({ batch, keepalive }),
        buildId: 'abc123',
      },
      buffer,
    );

    tracker.trackPageView();
    tracker.onPageLeave();

    const batch = sent[0]!.batch;
    expect(batch.v).toBe(1);
    expect(batch.buildId).toBe('abc123');
    expect(batch.tracks[0]).toBe('');
    expect(batch.urls).toEqual([URL]);
    // Every present column is exactly n long.
    for (const column of Object.values(batch.cols)) {
      expect(column).toHaveLength(batch.n);
    }
  });
});
