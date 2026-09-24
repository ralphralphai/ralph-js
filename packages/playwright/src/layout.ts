import type { Page } from '@playwright/test';

import type { PageLayout } from './types';

export function readLayout(page: Page): Promise<PageLayout> {
  return page
    .locator('[data-track-id]')
    .filter({ visible: true })
    .evaluateAll((elements) => ({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        width: Math.max(
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
          document.body?.scrollWidth ?? 0,
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.documentElement.clientHeight,
          document.body?.scrollHeight ?? 0,
        ),
      },
      scroll: { x: window.scrollX, y: window.scrollY },
      devicePixelRatio: window.devicePixelRatio,
      trackedElements: elements.flatMap((element) => {
        const trackId = element.getAttribute('data-track-id');
        const rect = element.getBoundingClientRect();
        // Off-screen horizontally (drawers, carousel slides) is dropped like
        // the crawler does; below the fold is kept, since the capture is
        // full-page.
        if (
          !trackId ||
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.right <= 0 ||
          rect.left >= window.innerWidth
        ) {
          return [];
        }
        return [
          {
            trackId,
            x: rect.x + window.scrollX,
            y: rect.y + window.scrollY,
            width: rect.width,
            height: rect.height,
          },
        ];
      }),
    }));
}
