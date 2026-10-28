import { createHash } from 'node:crypto';

import type { BrowserContext, Page, Request } from '@playwright/test';

type ImageHashes = Map<string, Promise<string | undefined>>;

// Matches the default timeout of the `page.request` fetch this replaced.
const IMAGE_HASH_TIMEOUT_MS = 30_000;

const hashesByPage = new WeakMap<Page, ImageHashes>();

/**
 * The latest hash per url across all of a context's pages. The HTTP cache is
 * shared by the context, so this is the copy a 304 tells any of them to reuse.
 */
const hashesByContext = new WeakMap<BrowserContext, ImageHashes>();

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hashes every image the context's pages load, as they load, so a snapshot
 * hashes the bytes the page showed instead of fetching them a second time. A
 * second fetch of a page's images comes as a burst, which hosts such as
 * upload.wikimedia.org answer with 429 for a share of them, and the image then
 * reads as replaced. Only the hash is kept, not the body. Entries persist
 * across navigations until another request for the same image replaces them
 * or the page closes.
 *
 * Watched on the context rather than each page: Playwright reports a popup
 * only once its first navigation has committed, and the images that document
 * requests early are gone by the time a listener can be added to the page.
 */
export function watchImageResponses(context: BrowserContext): void {
  if (hashesByContext.has(context)) {
    return;
  }

  const latest: ImageHashes = new Map();
  hashesByContext.set(context, latest);
  context.on('request', (request) => {
    // `request.frame()` throws for a service worker's own requests, which
    // belong to no page.
    if (request.resourceType() !== 'image' || request.serviceWorker()) {
      return;
    }

    const hashes = pageHashes(request.frame().page());
    // `response.body()` throws on a 304, and the page shows the cached copy,
    // which is the latest one any page in this context loaded.
    const cached = latest.get(request.url());
    // Replace the entry as soon as the load starts, including failed loads.
    // Store the promise now so an older response finishing late cannot
    // overwrite a newer request's hash.
    const hash = request
      .response()
      .then(async (response) => {
        if (response?.status() === 304) {
          return cached;
        }

        return response?.ok() ? sha256(await response.body()) : undefined;
      })
      .catch(() => undefined);
    // A redirect's own response has no body, and the element still names the
    // url it asked for, so the hash is kept under every url of the chain.
    for (const url of redirectChain(request)) {
      hashes.set(url, hash);
      latest.set(url, hash);
    }
  });
}

function pageHashes(page: Page): ImageHashes {
  const existing = hashesByPage.get(page);
  if (existing) {
    return existing;
  }

  const hashes: ImageHashes = new Map();
  hashesByPage.set(page, hashes);
  page.once('close', () => hashesByPage.delete(page));
  return hashes;
}

function redirectChain(request: Request): string[] {
  const urls: string[] = [];
  for (
    let redirected: Request | null = request;
    redirected !== null;
    redirected = redirected.redirectedFrom()
  ) {
    urls.push(redirected.url());
  }
  return urls;
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
