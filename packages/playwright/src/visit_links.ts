import type { Locator, Page } from '@playwright/test';

import type { VisitAllLinksOptions } from './types';

/**
 * Opens each link in a popup of the page it is on. A popup's first node links
 * to its opener's latest, so every target links from that page. Following the
 * links in one tab would link each target to the one before it, and a
 * modifier click opens a tab without an opener, which links to nothing.
 * `rel="opener"` keeps the opener that `target="_blank"` alone would drop.
 */
export const visitAllLinks = async (
  links: Locator,
  waitForCapture: () => Promise<void>,
  options: VisitAllLinksOptions = {},
): Promise<void> => {
  await links.first().waitFor();
  const all = await links.all();

  // Checked before opening any, so a failure leaves no partial walk behind.
  const notLinks = (await Promise.all(all.map(describeIfNotLink))).filter(
    (tag) => tag !== undefined,
  );
  if (notLinks.length > 0) {
    throw new Error(
      'visitAllLinks opens each match in a new tab, so each must be a link (<a href>). Not links: ' +
        notLinks.join(', '),
    );
  }

  for (const link of all) {
    const opened = await openInPopup(link);
    await opened.waitForLoadState('domcontentloaded');
    await options.onVisit?.(opened);
    await waitForCapture();
    await opened.close();
  }
};

const describeIfNotLink = (link: Locator): Promise<string | undefined> =>
  link.evaluate((element) => {
    if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) {
      return undefined;
    }
    return element.outerHTML.slice(0, element.outerHTML.indexOf('>') + 1);
  });

const openInPopup = async (link: Locator): Promise<Page> => {
  const original = await link.evaluate((element) => {
    const attributes = {
      target: element.getAttribute('target'),
      rel: element.getAttribute('rel'),
    };

    // Instead of ctrl+click, we inject the target and rel manually because the
    // browser does not pass the opener when clicked open in a new tab.
    element.setAttribute('target', '_blank');
    element.setAttribute('rel', 'opener');

    return attributes;
  });

  try {
    const [popup] = await Promise.all([
      link.page().waitForEvent('popup'),
      link.click(),
    ]);
    return popup;
  } finally {
    // Restored so a later step that clicks the link opens it as the page would.
    // The click may have re-rendered it away, leaving nothing to restore.
    await link
      .evaluate((element, attributes) => {
        for (const [name, value] of Object.entries(attributes)) {
          if (value === null) {
            element.removeAttribute(name);
          } else {
            element.setAttribute(name, value);
          }
        }
      }, original)
      .catch(() => undefined);
  }
};
