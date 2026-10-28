import { once } from 'node:events';
import { createServer } from 'node:http';

import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  loadedImageHash,
  sha256,
  watchImageResponses,
} from '../src/image_responses';

const imageUrl = 'https://images.test/logo.svg';
const svg = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="${color}"/></svg>`;
const html = '<!doctype html><img alt="Logo" src="/logo.svg">';
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

it('retains hashes across navigations and updates them when images load again', async () => {
  const page = await browser.newPage();
  let color = 'red';
  await page.route('https://images.test/**', (route) => {
    if (route.request().url() === imageUrl) {
      return route.fulfill({ contentType: 'image/svg+xml', body: svg(color) });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: route.request().url().endsWith('/empty') ? '<!doctype html>' : html,
    });
  });
  watchImageResponses(page.context());

  try {
    await page.goto('https://images.test/first');
    expect(await loadedImageHash(page, imageUrl)).toBe(sha256(svg('red')));

    // A fragment navigation retains the document and its loaded images.
    await page.goto('https://images.test/first#details');
    expect(await loadedImageHash(page, imageUrl)).toBe(sha256(svg('red')));

    await page.goto('https://images.test/empty');
    expect(await loadedImageHash(page, imageUrl)).toBe(sha256(svg('red')));

    color = 'blue';
    await page.goto('https://images.test/first');
    expect(await loadedImageHash(page, imageUrl)).toBe(sha256(svg('blue')));

    color = 'green';
    await page.reload();
    expect(await loadedImageHash(page, imageUrl)).toBe(sha256(svg('green')));
  } finally {
    await page.close();
  }
});

it('hashes the images a popup loads before Playwright reports the popup', async () => {
  const page = await browser.newPage();
  // On the context, because a page's routes do not cover its popups.
  await page.context().route('https://images.test/**', (route) => {
    if (route.request().url() === imageUrl) {
      return route.fulfill({ contentType: 'image/svg+xml', body: svg('red') });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: route.request().url().endsWith('/opener')
        ? '<!doctype html><a href="/first" target="_blank" rel="opener">Open</a>'
        : html,
    });
  });
  watchImageResponses(page.context());

  try {
    await page.goto('https://images.test/opener');
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByText('Open').click(),
    ]);
    await popup.waitForLoadState('load');
    expect(await loadedImageHash(popup, imageUrl)).toBe(sha256(svg('red')));
  } finally {
    await page.context().close();
  }
});

it.each(['204', 'download', 'abort'] as const)(
  'preserves hashes when a navigation does not commit (%s)',
  async (kind) => {
    const page = await browser.newPage();
    await page.route('https://images.test/**', (route) => {
      const url = route.request().url();
      if (url === imageUrl) {
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: svg('red'),
        });
      }
      if (url.endsWith('/attempt')) {
        if (kind === '204') {
          return route.fulfill({ status: 204 });
        }
        if (kind === 'abort') {
          return route.abort('aborted');
        }
        return route.fulfill({
          contentType: 'application/octet-stream',
          headers: {
            'content-disposition': 'attachment; filename="example.txt"',
          },
          body: 'example',
        });
      }
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    watchImageResponses(page.context());

    try {
      await page.goto('https://images.test/first');
      expect(await loadedImageHash(page, imageUrl)).toBe(sha256(svg('red')));

      await expect(page.goto('https://images.test/attempt')).rejects.toThrow();
      expect(page.url()).toBe('https://images.test/first');
      expect(
        await page
          .getByAltText('Logo')
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      ).toBe(40);
      expect(await loadedImageHash(page, imageUrl)).toBe(sha256(svg('red')));
    } finally {
      await page.close();
    }
  },
);

it.each(['http', 'network'] as const)(
  'does not reuse a successful hash after a reload with an %s failure',
  async (failure) => {
    const page = await browser.newPage();
    let fail = false;
    await page.route('https://images.test/**', (route) => {
      if (route.request().url() !== imageUrl) {
        return route.fulfill({ contentType: 'text/html', body: html });
      }
      if (fail) {
        return failure === 'http'
          ? route.fulfill({ status: 404, body: 'Not found' })
          : route.abort();
      }
      return route.fulfill({ contentType: 'image/svg+xml', body: svg('red') });
    });
    watchImageResponses(page.context());

    try {
      await page.goto('https://images.test/first');
      expect(await loadedImageHash(page, imageUrl)).toBe(sha256(svg('red')));

      fail = true;
      await page.reload();
      expect(
        await page
          .getByAltText('Logo')
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      ).toBe(0);
      expect(await loadedImageHash(page, imageUrl)).toBeUndefined();
    } finally {
      await page.close();
    }
  },
);

// Playwright turns the HTTP cache off while a route is set, so revalidation
// needs a real server.
it('keeps the cached hash when a reload revalidates the image with a 304', async () => {
  const server = createServer((request, response) => {
    if (request.url !== '/logo.svg') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(html);
      return;
    }

    if (request.headers['if-none-match'] === '"v1"') {
      response.writeHead(304, { etag: '"v1"' }).end();
      return;
    }

    response
      .writeHead(200, {
        'content-type': 'image/svg+xml',
        'cache-control': 'no-cache',
        etag: '"v1"',
      })
      .end(svg('red'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address.');
  }
  const origin = 'http://127.0.0.1:' + address.port;
  const page = await browser.newPage();
  watchImageResponses(page.context());

  try {
    await page.goto(origin + '/first');
    expect(await loadedImageHash(page, origin + '/logo.svg')).toBe(
      sha256(svg('red')),
    );

    const revalidated = page.waitForResponse((response) => {
      return response.url().endsWith('/logo.svg') && response.status() === 304;
    });
    await page.reload();
    await revalidated;
    expect(await loadedImageHash(page, origin + '/logo.svg')).toBe(
      sha256(svg('red')),
    );
  } finally {
    await page.close();
    server.closeAllConnections();
    server.close();
  }
});

// A route fulfills the whole body at once, so a real server holds the image
// open after its headers.
it('gives up on an image that never finishes loading', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/page') {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><img alt="Slow" src="/slow.svg">');
    } else {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.write('<svg');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address.');
  }
  const origin = 'http://127.0.0.1:' + address.port;
  const page = await browser.newPage();
  watchImageResponses(page.context());

  try {
    await page.goto(origin + '/page', { waitUntil: 'domcontentloaded' });
    expect(
      await loadedImageHash(page, origin + '/slow.svg', 500),
    ).toBeUndefined();
  } finally {
    await page.close();
    server.closeAllConnections();
    server.close();
  }
});
