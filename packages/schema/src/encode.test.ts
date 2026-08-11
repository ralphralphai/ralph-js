import { describe, expect, it } from 'vitest';

import {
  encodeBatch,
  type RawEvent,
  aggregateRawEvents,
  transpose,
} from '@/encode';

// These mirror `rust/src/api/columnar_tests.rs` case for case, and carry the
// same caveat: passing on both sides does not prove the two sides agree. Each can
// be self-consistent and still disagree. Rust reading `tr` as 0-based against an
// encoder writing it 1-based passes here and in cargo test, and misattributes
// every tracked click in production. Only a committed cross-language batch would
// close that, which the ADR defers.

const identity = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
};

const SIZE: [number, number] = [1280, 800];

describe('lookup tables', () => {
  it('reserves tracks[0] as the empty string', () => {
    const { tables } = aggregateRawEvents([
      { ty: 1, at: 0, trackId: 'cta.signup' },
    ]);

    expect(tables.tracks).toEqual(['', 'cta.signup']);
  });

  it('gives a repeated url one table entry and an index per event', () => {
    const url = 'https://example.com/pricing?utm_source=x';
    const { events, tables } = aggregateRawEvents([
      { ty: 5, at: 0, url, size: SIZE, sx: 0, sy: 0 },
      { ty: 5, at: 250, url, size: SIZE, sx: 0, sy: 120 },
    ]);

    expect(tables.urls).toEqual([url]);
    expect(tables.sizes).toEqual([SIZE]);
    expect(events.map((e) => 'u' in e && e.u)).toEqual([0, 0]);
  });

  it('delta-encodes timestamps against t0', () => {
    const { t0, events } = aggregateRawEvents([
      { ty: 6, at: 1_700_000_000_000 },
      { ty: 7, at: 1_700_000_001_250 },
    ]);

    expect(t0).toBe(1_700_000_000_000);
    expect(events.map((e) => e.dt)).toEqual([0, 1250]);
  });
});

describe('presence rules', () => {
  it('omits tr, rx and ry on an untracked click', () => {
    const { events } = aggregateRawEvents([
      { ty: 4, at: 0, url: 'https://e.com/', size: SIZE, px: 10, py: 20 },
    ]);

    expect(events[0]).toEqual({ dt: 0, ty: 4, u: 0, s: 0, px: 10, py: 20 });
  });

  it("keeps rx and ry of 0 on a click at a tracked element's corner", () => {
    // Gating on the value itself would silently drop this position.
    const { events } = aggregateRawEvents([
      {
        ty: 4,
        at: 0,
        url: 'https://e.com/',
        size: SIZE,
        px: 0,
        py: 0,
        trackId: 'cta.signup',
        rx: 0,
        ry: 0,
      },
    ]);

    expect(events[0]).toEqual({
      dt: 0,
      ty: 4,
      u: 0,
      s: 0,
      px: 0,
      py: 0,
      tr: 1,
      rx: 0,
      ry: 0,
    });
  });

  it('encodes a run of one as an absent c', () => {
    const { events } = aggregateRawEvents([
      { ty: 8, at: 0, url: 'https://e.com/', size: SIZE, px: 5, py: 5 },
      {
        ty: 8,
        at: 250,
        url: 'https://e.com/',
        size: SIZE,
        px: 5,
        py: 10,
        count: 1,
      },
      {
        ty: 8,
        at: 500,
        url: 'https://e.com/',
        size: SIZE,
        px: 5,
        py: 15,
        count: 6,
      },
    ]);

    expect(events.map((e) => ('c' in e ? e.c : undefined))).toEqual([
      undefined,
      undefined,
      6,
    ]);
  });
});

describe('transpose', () => {
  it('drops an all-zero sparse column', () => {
    const cols = transpose(
      aggregateRawEvents([
        { ty: 6, at: 0 },
        { ty: 7, at: 5 },
      ]).events,
    );

    expect(Object.keys(cols).sort()).toEqual(['dt', 'ty']);
    expect(cols.dt).toEqual([0, 5]);
    expect(cols.ty).toEqual([6, 7]);
  });

  it('drops sx for a session that never scrolls horizontally', () => {
    const cols = transpose(
      aggregateRawEvents([
        { ty: 5, at: 0, url: 'https://e.com/', size: SIZE, sx: 0, sy: 900 },
      ]).events,
    );

    expect(cols).not.toHaveProperty('sx');
    expect(cols.sy).toEqual([900]);
  });

  it('leaves a dead slot as filler rather than borrowing a neighbour', () => {
    const cols = transpose(
      aggregateRawEvents([
        { ty: 4, at: 0, url: 'https://e.com/', size: SIZE, px: 11, py: 22 },
        { ty: 7, at: 1 },
        { ty: 8, at: 2, url: 'https://e.com/', size: SIZE, px: 33, py: 44 },
      ]).events,
    );

    expect(cols.px).toEqual([11, 0, 33]);
    expect(cols.py).toEqual([22, 0, 44]);
  });

  it('makes every present column exactly n long', () => {
    const raw: RawEvent[] = [
      { ty: 6, at: 0 },
      { ty: 4, at: 10, url: 'https://e.com/', size: SIZE, px: 1, py: 2 },
      { ty: 5, at: 20, url: 'https://e.com/', size: SIZE, sx: 0, sy: 3 },
      { ty: 7, at: 30 },
    ];
    const cols = transpose(aggregateRawEvents(raw).events);

    for (const [name, column] of Object.entries(cols)) {
      expect(column, name).toHaveLength(raw.length);
    }
  });
});

describe('encodeBatch', () => {
  it('materialises only the columns a realistic batch needs', () => {
    const batch = encodeBatch(identity, [
      { ty: 6, at: 0 },
      {
        ty: 4,
        at: 100,
        url: 'https://e.com/',
        size: SIZE,
        px: 40,
        py: 80,
        trackId: 'cta.signup',
        rx: 4,
        ry: 8,
      },
      { ty: 5, at: 350, url: 'https://e.com/', size: SIZE, sx: 0, sy: 200 },
      {
        ty: 8,
        at: 600,
        url: 'https://e.com/',
        size: SIZE,
        px: 300,
        py: 400,
        count: 12,
      },
      { ty: 7, at: 900 },
    ]);

    expect(batch.v).toBe(1);
    expect(batch.n).toBe(5);
    expect(batch.urls).toEqual(['https://e.com/']);
    expect(batch.tracks).toEqual(['', 'cta.signup']);

    // Three columns drop out. `sx` because the page never scrolls sideways, and
    // `u` and `s` because a single-page batch has one url and one viewport, so
    // every event's index is 0, which is indistinguishable from filler and
    // therefore free.
    expect(Object.keys(batch.cols).sort()).toEqual([
      'c',
      'dt',
      'px',
      'py',
      'rx',
      'ry',
      'sy',
      'tr',
      'ty',
    ]);
  });

  it('reports n explicitly rather than leaving it to be inferred', () => {
    const batch = encodeBatch(identity, [
      { ty: 6, at: 0 },
      { ty: 7, at: 1 },
    ]);

    expect(batch.n).toBe(2);
    expect(batch.cols.dt).toHaveLength(batch.n);
  });

  it('handles an empty batch', () => {
    const batch = encodeBatch(identity, []);

    expect(batch.n).toBe(0);
    expect(batch.cols.dt).toEqual([]);
    expect(batch.urls).toEqual([]);
    expect(batch.tracks).toEqual(['']);
  });
});
