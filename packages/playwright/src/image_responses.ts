import { createHash } from 'node:crypto';

import type { Page } from '@playwright/test';

type ImageHashes = Map<string, Promise<string | undefined>>;

// Matches the default timeout of the `page.request` fetch this replaced.
const IMAGE_HASH_TIMEOUT_MS = 30_000;

const hashesByPage = new WeakMap<Page, ImageHashes>();

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hashes every image the page loads, as it loads, so a snapshot hashes the
 * bytes the page showed instead of fetching them a second time. A second fetch
 * of a page's images comes as a burst, which hosts such as
 * upload.wikimedia.org answer with 429 for a share of them, and the image then
 * reads as replaced. Only the hash is kept, not the body. Entries persist
 * across navigations until another request for the same image replaces them
 * or the page closes.
 */
export function watchImageResponses(page: Page): void {
  if (hashesByPage.has(page)) {
    return;
  }

  const hashes: ImageHashes = new Map();
  hashesByPage.set(page, hashes);
  page.on('request', (request) => {
    if (request.resourceType() !== 'image') {
      return;
    }

    // Replace the entry as soon as the load starts, including failed loads.
    // Store the promise now so an older response finishing late cannot
    // overwrite a newer request's hash.
    const hash = request
      .response()
      .then(async (response) => {
        return response?.ok() ? sha256(await response.body()) : undefined;
      })
      .catch(() => undefined);
    // A redirect's own response has no body, and the element still names the
    // url it asked for, so the hash is kept under every url of the chain.
    for (
      let redirected: typeof request | null = request;
      redirected !== null;
      redirected = redirected.redirectedFrom()
    ) {
      hashes.set(redirected.url(), hash);
    }
  });
  page.once('close', () => hashesByPage.delete(page));
}

/**
 * The hash from the latest observed request for this URL, across navigations.
 * Undefined when no request was observed, the latest load failed, or it has
 * not finished within the timeout, so an image that never finishes loading
 * cannot stall a snapshot.
 */
export async function loadedImageHash(
  page: Page,
  url: string,
  timeoutMs = IMAGE_HASH_TIMEOUT_MS,
): Promise<string | undefined> {
  const hash = hashesByPage.get(page)?.get(url.split('#')[0]!);
  if (hash === undefined) {
    return undefined;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, undefined);
  });
  try {
    return await Promise.race([hash, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
