// The event union, and the columns derived from it.
//
// Rust is the source of truth for this format. The union below is the *generated*
// one (`openapi.json` publishes `RalphEvent` as a component even though nothing on
// the wire ever has that shape), so this file derives the column layout from it
// rather than restating either.
//
// See docs/adr/0001-initial-setup.md, "The compact event format".

import type { components } from '@/generated/openapi';

/** One decoded event. Generated from the Rust declaration, not hand-written. */
export type RalphEvent = components['schemas']['RalphEvent'];

export type PressableEvent = components['schemas']['PressableEvent'];
export type PageClickEvent = components['schemas']['PageClickEvent'];
export type PageViewEvent = components['schemas']['PageViewEvent'];
export type SessionStartEvent = components['schemas']['SessionStartEvent'];
export type SessionEndEvent = components['schemas']['SessionEndEvent'];
export type MouseMoveEvent = components['schemas']['MouseMoveEvent'];

/** Every key that appears on any variant. Distributive, so it unions rather than intersects. */
type AllKeys<T> = T extends unknown ? keyof T : never;

/**
 * The keys common to every variant.
 *
 * `keyof` over a union yields only the shared keys, so `dt` and `ty` fall out as
 * the two mandatory columns without being listed anywhere.
 */
type Mandatory = keyof RalphEvent;

/** The other ten. */
type Sparse = Exclude<AllKeys<RalphEvent>, Mandatory>;

/** Collapse an intersection of mapped types into one object type, preserving optionality. */
type Flatten<T> = { [K in keyof T]: T[K] };

/**
 * The wire layout: struct-of-arrays over a batch's events.
 *
 * Generated, not written. Adding a variant, or moving a field between variants,
 * widens or narrows this automatically. There is no second list to drift out of
 * step, which is the failure mode a hand-written column list would have.
 */
export type Columns = Flatten<
  { [K in Mandatory]: number[] } & { [K in Sparse]?: number[] }
>;

/**
 * The derivation above must equal the `Columns` Rust published.
 *
 * Rust writes its per-`ty` structs and its `Columns` out separately, so those are
 * two independent statements of the column set. Deriving from the union here and
 * comparing makes this a real cross-check on them: a column declared on a variant
 * but missing from `Columns`, or the reverse, is a type error on this line. It was
 * only a redundancy check while Rust generated both from one declaration.
 */
type Eq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

export type _ColumnsMatchesSpec = Expect<
  Eq<Columns, components['schemas']['Columns']>
>;

/** The ingest request body. */
export type EventBatch = components['schemas']['EventBatch'];

/** The `ty` discriminator values.
 *
 * The numbers are unchanged from the legacy `AppUsageType` so its existing
 * `UserAppUsage` rows stay importable later; the gaps at 2 (`Scrollable`, zero
 * producers) and 3 (`Session`, already deprecated) are intentional.
 */
export const EventType = {
  Pressable: 1,
  PageClick: 4,
  PageView: 5,
  SessionStart: 6,
  SessionEnd: 7,
  MouseMove: 8,
} as const satisfies Record<string, RalphEvent['ty']>;

export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * The tracker samples page-view and mouse position on this cadence and
 * run-length-encodes consecutive identical samples.
 *
 * Shared so the client's sampling cadence and the server's run-duration maths
 * stay in lockstep: an effective count of `k` represents samples at the encoded
 * timestamp plus `0, 250, ... (k - 1) * 250` ms.
 */
export const SAMPLE_INTERVAL_MS = 250;

/**
 * Mouse position is quantized to this grid before run-length encoding.
 *
 * Load-bearing rather than a detail: runs are compared for exact equality, so
 * 1 px of jitter defeats them. That costs more than bytes: it multiplies the
 * event count by up to 30x, and with it the request and batch-row counts.
 */
export const MOUSE_GRID_PX = 5;

/** `tracks[0]` is reserved, so `tr === 0` means "no tracked element". */
export const NO_TRACK_INDEX = 0;
