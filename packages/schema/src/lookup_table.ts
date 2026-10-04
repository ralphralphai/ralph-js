import { ViewportSize } from './encode';
import type { Tags } from '@/events';

/** A list of distinct strings, addressed by position. */
export class StringLookupTable {
  readonly values: string[];
  private readonly positions = new Map<string, number>();

  constructor(reserved?: string) {
    this.values = [];
    if (reserved !== undefined) {
      this.values.push(reserved);
      this.positions.set(reserved, 0);
    }
  }

  /** The value's position, appending it first if this is its first occurrence. */
  indexFor(value: string): number {
    const existing = this.positions.get(value);
    if (existing !== undefined) {
      return existing;
    }

    const next = this.values.push(value) - 1;
    this.positions.set(value, next);
    return next;
  }
}

// Identical to StringLookupTable, but for ViewportSize as ViewportSize isn't
// trivially keyable.
export class ViewportSizeLookupTable {
  readonly values: ViewportSize[] = [];
  private readonly positions = new Map<string, number>();

  indexFor(size: ViewportSize): number {
    const key = `${size[0]}x${size[1]}`;
    const existing = this.positions.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const next = this.values.push(size) - 1;
    this.positions.set(key, next);
    return next;
  }
}

// Keyed by the entries sorted, so one set spelled in two key orders interns
// once. `[0]` is reserved as the empty set.
export class TagsLookupTable {
  readonly values: Tags[] = [{}];
  private readonly positions = new Map<string, number>([['[]', 0]]);

  indexFor(tags: Tags): number {
    const key = JSON.stringify(
      Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    const existing = this.positions.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const next = this.values.push(tags) - 1;
    this.positions.set(key, next);
    return next;
  }
}
