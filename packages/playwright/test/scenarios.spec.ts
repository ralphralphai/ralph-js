import { once } from 'node:events';
import { createServer } from 'node:http';

import { test as nativeTest } from '@playwright/test';

import { test, expect, mergeTests } from '../dist/index.mjs';

const html =
  '<!doctype html><html><head><style>body { margin: 0; height: 1400px } #tracked { position: absolute; left: 20px; top: 40px; width: 120px; height: 32px } #below { position: absolute; left: 30px; top: 1000px; width: 100px; height: 20px }</style></head><body><button id="tracked" data-track-id="checkout">Checkout</button><div id="below" data-track-id="below">Below</div><button hidden data-track-id="hidden">Hidden</button></body></html>';

const navHtml =
  '<!doctype html><html><body style="margin: 0">' +
  '<a href="/next" data-follow-id="go-next" data-track-id="next-link">Next</a> ' +
  '<a href="/popup" target="_blank" data-follow-id="open-popup">Popup</a> ' +
  "<button data-follow-id=\"spa\" onclick=\"history.pushState({}, '', '/a'); history.pushState({}, '', '/b')\">SPA</button>" +
  '<div data-track-id="offscreen" style="position: absolute; left: -300px; top: 0; width: 100px; height: 20px"></div>' +
  '</body></html>';

test('navigation flow', { tag: '@ralph' }, async ({ context, page, ralph }) => {
  // On the context, so the popup is served too.
  await context.route('https://nav.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: navHtml }),
  );
  await page.goto('https://nav.test/start');
  await ralph.flush();
  // A link that navigates.
  await page.click('[data-follow-id="go-next"]');
  await expect(page).toHaveURL('https://nav.test/next');
  await ralph.flush();
  // A test-driven navigation.
  await page.goto('https://nav.test/back');
  await ralph.flush();
  // A link that opens a popup.
  const popupPromise = page.waitForEvent('popup');
  await page.click('[data-follow-id="open-popup"]');
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await ralph.flush();
  // A route that is immediately replaced by another.
  await page.click('[data-follow-id="spa"]');
  await expect(page).toHaveURL('https://nav.test/b');
  await ralph.flush();
});

test.beforeEach(async ({ context }) => {
  await context.route('https://fixture.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
});

test(
  'URL transitions and geometry',
  { tag: '@ralph' },
  async ({ page, ralph }) => {
    await page.goto('https://fixture.test/home');
    await ralph.flush();
    await page.goto('https://fixture.test/second');
    await ralph.flush();
    await page.evaluate(() =>
      history.pushState({}, '', '/second?step=1#details'),
    );
    await ralph.flush();
    await page.reload();
    await ralph.flush();
    await page.locator('body').evaluate((body) => {
      body.dataset.changed = 'yes';
    });
    await ralph.flush();
  },
);

test('explicit URL overrides', { tag: '@ralph' }, async ({ page, ralph }) => {
  await page.goto('https://fixture.test/cart');
  await ralph.flush();
  await page.evaluate(() => window.scrollTo(0, 600));
  await ralph.captureNode(page, {
    state: 'dialog',
    url: '/checkout/shipping-options',
  });
  await expect(page).toHaveURL('https://fixture.test/cart');
  await ralph.captureNode(page, {
    state: 'absolute',
    url: 'https://logical.test/cart',
  });
  await ralph.captureNode(page, { state: 'actual' });
  await expect(
    ralph.captureNode(page, { url: 'javascript:alert(1)' }),
  ).rejects.toThrow('HTTP');
});

test(
  'teardown drains automatic capture',
  { tag: '@ralph' },
  async ({ page }) => {
    await page.goto('https://fixture.test/final');
  },
);

test(
  'redirect final destination',
  { tag: '@ralph' },
  async ({ page, ralph }) => {
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/destination' }).end();
      } else {
        response.writeHead(200, { 'content-type': 'text/html' }).end(html);
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address.');
    }
    try {
      await page.goto('http://127.0.0.1:' + address.port + '/redirect');
      await ralph.flush();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test('superseded transitions', { tag: '@ralph' }, async ({ page, ralph }) => {
  await page.goto('https://fixture.test/home');
  await ralph.flush();
  await page.evaluate(() => {
    history.pushState({}, '', '/intermediate');
    history.pushState({}, '', '/final');
  });
  await ralph.flush();
});

test(
  'popup and iframe isolation',
  { tag: '@ralph' },
  async ({ page, ralph }) => {
    await page.goto('https://fixture.test/home');
    await ralph.flush();
    const popupPromise = page.waitForEvent('popup');
    await page.evaluate(() => window.open('/popup'));
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await ralph.flush();
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = '/embedded';
      document.body.append(frame);
    });
    await expect(page.locator('iframe')).toBeVisible();
    await ralph.flush();
  },
);

test(
  'manual context enrollment',
  { tag: '@ralph' },
  async ({ browser, ralph }) => {
    const context = await browser.newContext();
    await context.route('**/*', (route) =>
      route.fulfill({ body: html, contentType: 'text/html' }),
    );
    ralph.observe(context);
    const page = await context.newPage();
    await page.goto('https://fixture.test/custom');
    await ralph.flush();
    await context.close();
  },
);

test('retry attempts', { tag: '@ralph' }, async ({ page, ralph }, info) => {
  await page.goto('https://fixture.test/retry');
  await ralph.flush();
  expect(info.retry).toBe(1);
});

test('ordinary test remains unrecorded', async ({ page }) => {
  await page.goto('https://fixture.test/ordinary');
});

test('explicit capture requires opt-in', async ({ page, ralph }) => {
  await page.goto('https://fixture.test/ordinary');
  await expect(ralph.captureNode(page)).rejects.toThrow('@ralph');
});

test.describe('off mode', () => {
  test.use({
    ralphOptions: { mode: 'off', configPath: '/missing/config.jsonc' },
  });
  test('off capture is a no-op', { tag: '@ralph' }, async ({ page, ralph }) => {
    await page.goto('https://fixture.test/off');
    await ralph.captureNode(page, { url: '/logical' });
    await expect(page).toHaveURL('https://fixture.test/off');
  });
});

test.describe('readiness', () => {
  test.use({
    ralphOptions: {
      mode: 'local',
      config: { screenSizes: [] },
      settleMs: 0,
      captureTimeoutMs: 1000,
      ready: async (page) => {
        await page.waitForFunction(() => document.body.dataset.ready === 'yes');
      },
    },
  });
  test('readiness hook', { tag: '@ralph' }, async ({ page, ralph }) => {
    await page.goto('https://fixture.test/ready');
    await page.evaluate(() => {
      document.body.dataset.ready = 'yes';
    });
    await ralph.flush();
  });
  test('readiness timeout is bounded', { tag: '@ralph' }, async ({ page }) => {
    test.fail();
    await page.goto('https://fixture.test/never-ready');
  });
});

const databaseTest = nativeTest.extend<{ account: string }>({
  // Playwright requires destructuring here to discover fixture dependencies.
  // oxlint-disable-next-line no-empty-pattern
  account: async ({}, use) => {
    await use('customer');
  },
});
const combined = mergeTests(databaseTest, test);
combined(
  'composes customer fixtures',
  { tag: '@ralph' },
  async ({ page, account, ralph }) => {
    expect(account).toBe('customer');
    await page.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await page.goto('https://fixture.test/composed');
    await ralph.flush();
  },
);

nativeTest('native Playwright test', async () => {
  expect(2 + 2).toBe(4);
});
