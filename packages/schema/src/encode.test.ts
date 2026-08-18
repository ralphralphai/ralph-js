import { describe, expect, it } from 'vitest';

import {
  BatchType,
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

/** What a native app sends in place of a url, having none to intern. */
const NAV_PARAM = '/checkout?step=payment';

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

  it('interns an app sample into appNavParams rather than urls', () => {
    const { events, tables } = aggregateRawEvents([
      { ty: 5, at: 0, navParam: NAV_PARAM, size: SIZE, sx: 0, sy: 0 },
      { ty: 5, at: 250, navParam: NAV_PARAM, size: SIZE, sx: 0, sy: 120 },
    ]);

    expect(tables.appNavParams).toEqual([NAV_PARAM]);
    expect(tables.urls).toEqual([]);
    expect(events.map((e) => 'a' in e && e.a)).toEqual([0, 0]);
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

  it('gives an app click an a and no u at all', () => {
    const { events } = aggregateRawEvents([
      { ty: 4, at: 0, navParam: NAV_PARAM, size: SIZE, px: 10, py: 20 },
    ]);

    expect(events[0]).toEqual({ dt: 0, ty: 4, a: 0, s: 0, px: 10, py: 20 });
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

  it('keeps an all-zero u, since presence is what names the nav table', () => {
    // The one column the all-zero rule does not reach. A single-page batch
    // indexes `urls[0]` from every event, and dropping the column for being
    // zero would leave nothing saying it was `urls` rather than
    // `appNavParams` those events addressed.
    const cols = transpose(
      aggregateRawEvents([
        { ty: 5, at: 0, url: 'https://e.com/', size: SIZE, sx: 0, sy: 900 },
      ]).events,
    );

    expect(cols.u).toEqual([0]);
    expect(cols).not.toHaveProperty('a');
  });

  it('keeps an all-zero a for the same reason', () => {
    const cols = transpose(
      aggregateRawEvents([
        { ty: 5, at: 0, navParam: NAV_PARAM, size: SIZE, sx: 0, sy: 900 },
      ]).events,
    );

    expect(cols.a).toEqual([0]);
    expect(cols).not.toHaveProperty('u');
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
    expect(batch).not.toHaveProperty('appNavParams');
    expect(batch.tracks).toEqual(['', 'cta.signup']);

    // Two columns drop out. `sx` because the page never scrolls sideways, and
    // `s` because a single-viewport batch indexes 0 from every event, which is
    // indistinguishable from filler and therefore free. `u` is all zeros for
    // that same reason and stays anyway, because it is what names the table
    // those zeros index.
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
      'u',
    ]);
  });

  it('sends appNavParams in place of urls for an app batch', () => {
    const batch = encodeBatch(
      identity,
      [
        { ty: 6, at: 0 },
        { ty: 5, at: 250, navParam: NAV_PARAM, size: SIZE, sx: 0, sy: 0 },
        { ty: 7, at: 500 },
      ],
      BatchType.NativeApp,
    );

    expect(batch.appNavParams).toEqual([NAV_PARAM]);
    expect(batch).not.toHaveProperty('urls');

    // The dead slots either side of the page view are filler, as they are in
    // any other column, so `a` is all zeros and travels regardless.
    expect(Object.keys(batch.cols).sort()).toEqual(['a', 'dt', 'ty']);
    expect(batch.cols.a).toEqual([0, 0, 0]);
  });

  it('keeps the native app discriminator on a flush without navigation', () => {
    const batch = encodeBatch(
      identity,
      [{ ty: 7, at: 500 }],
      BatchType.NativeApp,
    );

    expect(batch.appNavParams).toEqual([]);
    expect(batch).not.toHaveProperty('urls');
  });

  it('rejects navigation events from a different batch type', () => {
    expect(() =>
      encodeBatch(
        identity,
        [
          {
            ty: 5,
            at: 0,
            navParam: NAV_PARAM,
            size: SIZE,
            sx: 0,
            sy: 0,
          },
        ],
        BatchType.Web,
      ),
    ).toThrow('A web batch cannot contain app navigation events');
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
    expect(batch.tracks).toEqual(['']);

    // The optional batch type defaults to web, so a batch that referenced no
    // page still carries the browser discriminator.
    expect(batch.urls).toEqual([]);
    expect(batch).not.toHaveProperty('appNavParams');
  });
});
