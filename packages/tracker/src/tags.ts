import type { Tags, TagValue } from '@ralphralphai/schema';

/** What the tag setters accept: an `undefined` value, as a flag lookup returns, is skipped. */
export type TagInput = Record<string, TagValue | undefined>;

export type RecordedTags = { visitorTags: Tags; pageTags: Tags };

declare global {
  interface Window {
    /**
     * Read by `@ralphralphai/playwright` when it records a page, to check the
     * conditions a test declares against the tags production events carry.
     */
    __ralphTags?: () => RecordedTags;
  }
}

const defined = (tags: TagInput): Tags => {
  const kept: Tags = {};
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined) {
      kept[key] = value;
    }
  }
  return kept;
};

/**
 * The visitor and page tags events are recorded with.
 *
 * Visitor tags hold across pages until changed or cleared, and are never
 * stored: the app sets them again on each load. Page tags clear on every URL
 * change, because they describe one page's state. Components tag one page
 * independently, so each `tagPage` call is a layer merged over the earlier ones
 * and its `untag` removes that layer alone.
 */
export class TagStore {
  private visitorTags: Tags = {};
  private url: string | undefined;
  private readonly pageLayers = new Map<symbol, Tags>();
  private readonly clearListeners = new Set<() => void>();

  at(url: string): RecordedTags {
    this.sync(url);
    return this.current();
  }

  setVisitorTags(tags: TagInput): void {
    this.visitorTags = { ...this.visitorTags, ...defined(tags) };
  }

  clearVisitorTags(keys?: string[]): void {
    if (keys === undefined) {
      this.visitorTags = {};
    } else {
      this.visitorTags = Object.fromEntries(
        Object.entries(this.visitorTags).filter(([key]) => !keys.includes(key)),
      );
    }
  }

  tagPage(tags: TagInput, url: string): () => void {
    this.sync(url);
    const key = Symbol();
    this.pageLayers.set(key, defined(tags));

    return () => {
      this.pageLayers.delete(key);
    };
  }

  /** Called when a URL change cleared the page tags, so a mounted hook can reapply its own. */
  onClear(listener: () => void): () => void {
    this.clearListeners.add(listener);
    return () => this.clearListeners.delete(listener);
  }

  private sync(url: string): void {
    if (url === this.url) {
      return;
    }
    this.url = url;
    if (this.pageLayers.size === 0) {
      return;
    }
    this.pageLayers.clear();
    for (const listener of this.clearListeners) {
      listener();
    }
  }

  private current(): RecordedTags {
    return {
      visitorTags: { ...this.visitorTags },
      pageTags: Object.assign({}, ...this.pageLayers.values()),
    };
  }
}

/** The store the exported functions and every `Tracker` share. */
export const tagStore = new TagStore();

/**
 * Tag the visitor with what changes what they see across pages: a plan, an
 * experiment group, a feature flag. Merges into the current visitor tags,
 * which last until changed or cleared and are not kept across a reload, so
 * set them again on each page load. Events recorded earlier keep the tags they
 * were recorded with.
 */
export const setVisitorTags = (tags: TagInput): void =>
  tagStore.setVisitorTags(tags);

/** Clears the named visitor tags, or all of them. */
export const clearVisitorTags = (keys?: string[]): void =>
  tagStore.clearVisitorTags(keys);

/**
 * Tag the page on screen with state its URL does not show: an open dialog, a
 * wizard step. Merges into the page's tags, which clear when the URL changes.
 * The returned function removes this call's tags, for a state that ends on
 * the same URL.
 */
export const tagPage = (tags: TagInput): (() => void) =>
  tagStore.tagPage(tags, window.location.href);

/** Whether two tag sets are the same set, whatever their key order. */
export const sameTags = (a: Tags = {}, b: Tags = {}): boolean => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => key in b && a[key] === b[key])
  );
};
