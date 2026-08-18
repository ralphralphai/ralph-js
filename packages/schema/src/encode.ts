// The batch encoder.
//
// Two steps, deliberately separate:
//
//   1. `aggregateRawEvents` turns semantic samples into aggregated events,
//      applying the encoding *rules*: the lookup tables, delta timestamps,
//      `tracks[0]` reservation, `c` of 0 meaning 1, `rx`/`ry` gated on `tr`.
//   2. `transpose` flattens aggregated events into columns. Purely mechanical:
//      an aggregated event carries exactly the fields that apply to its `ty`, so
//      its own shape *is* the applicability table and there is nothing to
//      restate.

import { StringLookupTable, ViewportSizeLookupTable } from './lookup_table';
import type { Columns, EventBatch, RalphEvent } from '@/events';
import { MOUSE_GRID_PX, NO_TRACK_INDEX } from '@/events';

type NavSource =
  | { url: string; navParam?: never }
  | { navParam: string; url?: never };

/** A sample as the tracker observes it: full urls and sizes, not yet indices. */
export type RawEvent =
  | { ty: 1; at: number; trackId: string }
  | ({
      ty: 4;
      at: number;
      size: ViewportSize;
      px: number;
      py: number;
      trackId?: string;
      rx?: number;
      ry?: number;
    } & NavSource)
  | ({
      ty: 5;
      at: number;
      size: ViewportSize;
      sx: number;
      sy: number;
      count?: number;
    } & NavSource)
  | { ty: 6; at: number }
  | { ty: 7; at: number }
  | ({
      ty: 8;
      at: number;
      size: ViewportSize;
      px: number;
      py: number;
      count?: number;
    } & NavSource);

export type ViewportSize = [width: number, height: number];

const MANDATORY_COLUMNS = ['dt', 'ty'] as const;
const SPARSE_COLUMNS = [
  'u',
  'a',
  's',
  'px',
  'py',
  'sx',
  'sy',
  'tr',
  'rx',
  'ry',
  'c',
] as const;

type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];
type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// Make sure that the columns are listed in the ingestor schema.
export type _MandatoryColumnsListed = Expect<
  Eq<(typeof MANDATORY_COLUMNS)[number], RequiredKeys<Columns>>
>;
export type _SparseColumnsListed = Expect<
  Eq<(typeof SPARSE_COLUMNS)[number], OptionalKeys<Columns>>
>;

export type LookupTables = {
  urls: string[];
  appNavParams: string[];
  tracks: string[];
  sizes: ViewportSize[];
};

type AggregateRawEvents = {
  t0: number;
  events: RalphEvent[];
  tables: LookupTables;
};
export function aggregateRawEvents(
  raw: readonly RawEvent[],
): AggregateRawEvents {
  // `tracks[0]` is reserved and always `''`, so `tr` of `0` means "no tracked
  // element" by construction rather than by a ±1 both decoders must remember.
  const tracks = new StringLookupTable('');
  const urls = new StringLookupTable();
  const appNavParams = new StringLookupTable();
  const sizes = new ViewportSizeLookupTable();

  const navIndexFor = (sample: NavSource): { u: number } | { a: number } =>
    sample.url === undefined
      ? { a: appNavParams.indexFor(sample.navParam) }
      : { u: urls.indexFor(sample.url) };

  const t0 = raw.length > 0 ? raw[0]!.at : 0;
  let previous = t0;

  const events = raw.map((sample): RalphEvent => {
    const dt = sample.at - previous;
    previous = sample.at;

    switch (sample.ty) {
      case 1:
        return { dt, ty: 1, tr: tracks.indexFor(sample.trackId) };

      case 4: {
        // The tracked-element index doubles as the presence flag for `rx`/`ry`;
        // there is no separate one. They cannot be gated on their own value,
        // because a click on a tracked element's top-left corner is legitimately
        // `rx === 0, ry === 0`.
        const tr =
          sample.trackId === undefined
            ? NO_TRACK_INDEX
            : tracks.indexFor(sample.trackId);

        return {
          dt,
          ty: 4,
          ...navIndexFor(sample),
          s: sizes.indexFor(sample.size),
          px: sample.px,
          py: sample.py,
          ...(tr === NO_TRACK_INDEX
            ? {}
            : { tr, rx: sample.rx ?? 0, ry: sample.ry ?? 0 }),
        };
      }

      case 5:
        return {
          dt,
          ty: 5,
          ...navIndexFor(sample),
          s: sizes.indexFor(sample.size),
          sx: sample.sx,
          sy: sample.sy,
          ...runLength(sample.count),
        };

      case 6:
        return { dt, ty: 6 };

      case 7:
        return { dt, ty: 7 };

      case 8:
        return {
          dt,
          ty: 8,
          ...navIndexFor(sample),
          s: sizes.indexFor(sample.size),
          px: sample.px,
          py: sample.py,
          ...runLength(sample.count),
        };
    }
  });

  return {
    t0,
    events,
    tables: {
      urls: urls.values,
      appNavParams: appNavParams.values,
      tracks: tracks.values,
      sizes: sizes.values,
    },
  };
}

/**
 * `c` of `0` means a count of `1`.
 *
 * A run of zero events is meaningless, so "omitted when 1" becomes "0 means 1",
 * and a batch where nothing run-length-encodes drops the `c` column entirely.
 * A count of 1 is therefore encoded as absent, which is the canonical form.
 */
function runLength(count: number | undefined): { c?: number } {
  return count === undefined || count <= 1 ? {} : { c: count };
}

/** The two columns whose presence, not whose values, carries meaning. */
const NAV_COLUMNS: ReadonlySet<string> = new Set(['u', 'a']);

/** Flatten events into parallel columns. */
export function transpose(events: readonly RalphEvent[]): Columns {
  const n = events.length;
  const cols: Record<string, number[]> = {};
  for (const name of [...MANDATORY_COLUMNS, ...SPARSE_COLUMNS]) {
    cols[name] = new Array<number>(n).fill(0);
  }

  const declared = new Set<string>();
  events.forEach((event, i) => {
    for (const [name, value] of Object.entries(event)) {
      if (typeof value === 'number') {
        cols[name]![i] = value;
        declared.add(name);
      }
    }
  });

  // A column is either absent or exactly `n` long, and absent is identical to a
  // column of `n` zeros, so an all-zero column is dropped. A session that never
  // scrolls horizontally carries no `sx`, a batch with no tracked clicks carries
  // no `tr`/`rx`/`ry`, and one where nothing folds carries no `c`.
  //
  // `u` and `a` drop on whether any event declared them instead, because 0 is a
  // real index into `urls` and into `appNavParams` alike. An all-zero nav
  // column is still what tells the decoder which of the two tables these events
  // address, so dropping it would take that answer with it.
  for (const name of SPARSE_COLUMNS) {
    const droppable = NAV_COLUMNS.has(name)
      ? !declared.has(name)
      : cols[name]!.every((value) => value === 0);

    if (droppable) {
      delete cols[name];
    }
  }

  return cols as Columns;
}

export type BatchIdentity = {
  /** SDK-generated anonymous UUID. */
  userId: string;
  sessionId: string;
  buildId?: string;
};

/** The SDK source whose navigation table discriminates the batch. */
export enum BatchType {
  NativeApp = 'nativeApp',
  Web = 'web',
}

/** Build a complete batch from samples. */
export function encodeBatch(
  identity: BatchIdentity,
  raw: readonly RawEvent[],
  type: BatchType = BatchType.Web,
): EventBatch {
  const { t0, events, tables } = aggregateRawEvents(raw);
  if (type === BatchType.NativeApp && tables.urls.length > 0) {
    throw new Error('A native app batch cannot contain URL events');
  }
  if (type === BatchType.Web && tables.appNavParams.length > 0) {
    throw new Error('A web batch cannot contain app navigation events');
  }

  const nav =
    type === BatchType.NativeApp
      ? { appNavParams: tables.appNavParams }
      : { urls: tables.urls };

  return {
    v: 1,
    userId: identity.userId,
    sessionId: identity.sessionId,
    ...(identity.buildId === undefined ? {} : { buildId: identity.buildId }),
    t0,
    ...nav,
    tracks: tables.tracks,
    sizes: tables.sizes,
    // Explicit rather than inferred from `dt.length`, so a truncated or
    // mismatched body fails validation server-side instead of decoding short.
    n: events.length,
    cols: transpose(events),
  };
}

/** Quantize a pointer coordinate to the grid the server buckets to anyway. */
export function quantizeMouse(value: number): number {
  return Math.round(value / MOUSE_GRID_PX) * MOUSE_GRID_PX;
}

/**
 * Serialize and gzip a batch.
 *
 * `CompressionStream('gzip')` is native, so this costs the bundle nothing. zstd
 * would mean shipping a wasm encoder for a marginal ratio gain.
 */
export async function gzipBatch(batch: EventBatch): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(batch));

  const stream = new Blob([json as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}
