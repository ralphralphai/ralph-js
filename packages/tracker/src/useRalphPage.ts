import { useEffect } from 'react';

import { type TagInput, tagPage, tagStore } from '@/tags';

/**
 * Tags the page on screen while the calling component is mounted.
 *
 * Reapplied after every URL change, since those clear the page tags, so a
 * component that stays mounted across a query-param change keeps its page
 * tagged.
 */
export const useRalphPage = (tags: TagInput): void => {
  const key = JSON.stringify(
    Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  useEffect(() => {
    let untag = tagPage(tags);

    const stop = tagStore.onClear(() => {
      untag = tagPage(tags);
    });

    return () => {
      stop();
      untag();
    };
    // Keyed by value, so a new object literal each render does not retag.
  }, [key]);
};
