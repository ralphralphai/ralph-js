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
  await ralph.waitForCapture();
  // A link that navigates.
  await page.click('[data-follow-id="go-next"]');
  await expect(page).toHaveURL('https://nav.test/next');
  await ralph.waitForCapture();
  // A test-driven navigation.
  await page.goto('https://nav.test/back');
  await ralph.waitForCapture();
  // A link that opens a popup.
  const popupPromise = page.waitForEvent('popup');
  await page.click('[data-follow-id="open-popup"]');
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await ralph.waitForCapture();
  // A route that is immediately replaced by another.
  await page.click('[data-follow-id="spa"]');
  await expect(page).toHaveURL('https://nav.test/b');
  await ralph.waitForCapture();
});

test.beforeEach(async ({ context }) => {
  await context.route('https://fixture.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
});

test('paused capture', { tag: '@ralph' }, async ({ page, ralph }) => {
  await page.goto('https://fixture.test/a');
  await ralph.waitForCapture();
  ralph.pause();
  await page.goto('https://fixture.test/b');
  await ralph.recordNode(page, { state: 'skipped' });
  await page.goto('https://fixture.test/c');
  ralph.resume();
  await page.goto('https://fixture.test/d');
  await ralph.waitForCapture();
});

test(
  'paused capture across pages',
  { tag: '@ralph' },
  async ({ page, ralph }) => {
    await page.goto('https://fixture.test/a');
    await ralph.waitForCapture();
    ralph.pause();
    // B opens in a popup, which opens C in another popup.
    const bPromise = page.waitForEvent('popup');
    await page.evaluate(() => window.open('/b'));
    const b = await bPromise;
    await b.waitForLoadState();
    const cPromise = b.waitForEvent('popup');
    await b.evaluate(() => window.open('/c'));
    const c = await cPromise;
    await c.waitForLoadState();
    ralph.resume();
    await c.goto('https://fixture.test/d');
    await ralph.waitForCapture();
  },
);

test(
  'URL transitions and geometry',
  { tag: '@ralph' },
  async ({ page, ralph }) => {
    await page.goto('https://fixture.test/home');
    await ralph.waitForCapture();
    await page.goto('https://fixture.test/second');
    await ralph.waitForCapture();
    await page.evaluate(() =>
      history.pushState({}, '', '/second?step=1#details'),
    );
    await ralph.waitForCapture();
    await page.reload();
    await ralph.waitForCapture();
    await page.locator('body').evaluate((body) => {
      body.dataset.changed = 'yes';
    });
    await ralph.waitForCapture();
  },
);

test('explicit URL overrides', { tag: '@ralph' }, async ({ page, ralph }) => {
  await page.goto('https://fixture.test/cart');
  await ralph.waitForCapture();
  await page.evaluate(() => window.scrollTo(0, 600));
  await ralph.recordNode(page, {
    state: 'dialog',
    url: '/checkout/shipping-options',
  });
  await expect(page).toHaveURL('https://fixture.test/cart');
  await ralph.recordNode(page, {
    state: 'absolute',
    url: 'https://logical.test/cart',
  });
  await ralph.recordNode(page, { state: 'actual' });
  await expect(
    ralph.recordNode(page, { url: 'javascript:alert(1)' }),
  ).rejects.toThrow('HTTP');
});

test(
  'teardown drains automatic recording',
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
      await ralph.waitForCapture();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test('same-URL history updates', { tag: '@ralph' }, async ({ page, ralph }) => {
  // What a client router such as TanStack Router does as it starts: stamp its
  // own state into the current entry, which fires a same-URL navigation.
  await page.route('https://router.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><script>history.replaceState({ key: 1 }, "")</script></head><body>Router</body></html>',
    }),
  );
  await page.goto('https://router.test/start');
  await ralph.waitForCapture();
});

test('replaced transitions', { tag: '@ralph' }, async ({ page, ralph }) => {
  await page.goto('https://fixture.test/home');
  await ralph.waitForCapture();
  await page.evaluate(() => {
    history.pushState({}, '', '/intermediate');
    history.pushState({}, '', '/final');
  });
  await ralph.waitForCapture();
});

test(
  'popup and iframe isolation',
  { tag: '@ralph' },
  async ({ page, ralph }) => {
    await page.goto('https://fixture.test/home');
    await ralph.waitForCapture();
    const popupPromise = page.waitForEvent('popup');
    await page.evaluate(() => window.open('/popup'));
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await ralph.waitForCapture();
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = '/embedded';
      document.body.append(frame);
    });
    await expect(page.locator('iframe')).toBeVisible();
    await ralph.waitForCapture();
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
    await ralph.waitForCapture();
    await context.close();
  },
);

test('retry attempts', { tag: '@ralph' }, async ({ page, ralph }, info) => {
  await page.goto('https://fixture.test/retry');
  await ralph.waitForCapture();
  expect(info.retry).toBe(1);
});

test('ordinary test remains unrecorded', async ({ page }) => {
  await page.goto('https://fixture.test/ordinary');
});

test('explicit recording requires opt-in', async ({ page, ralph }) => {
  await page.goto('https://fixture.test/ordinary');
  await expect(ralph.recordNode(page)).rejects.toThrow('@ralph');
});

test.describe('off mode', () => {
  test.use({
    ralphOptions: { mode: 'off', configPath: '/missing/config.jsonc' },
  });
  test(
    'off recording is a no-op',
    { tag: '@ralph' },
    async ({ page, ralph }) => {
      await page.goto('https://fixture.test/off');
      await ralph.recordNode(page, { url: '/logical' });
      await expect(page).toHaveURL('https://fixture.test/off');
    },
  );
});

test.describe('readiness', () => {
  test.use({
    ralphOptions: async ({ ralphOptions }, use) => {
      await use({
        ...ralphOptions,
        mode: 'local',
        recordTimeoutMs: 1000,
        ready: async (page) => {
          await page.waitForFunction(
            () => document.body.dataset.ready === 'yes',
          );
        },
      });
    },
  });
  test('readiness hook', { tag: '@ralph' }, async ({ page, ralph }) => {
    await page.goto('https://fixture.test/ready');
    await page.evaluate(() => {
      document.body.dataset.ready = 'yes';
    });
    await ralph.waitForCapture();
  });
  test('readiness timeout is bounded', { tag: '@ralph' }, async ({ page }) => {
    test.fail();
    await page.goto('https://fixture.test/never-ready');
  });
});

const animatedHtml =
  '<!doctype html><html><head><style>body { margin: 0 } #slide { position: absolute; left: 20px; top: 40px; width: 120px; height: 32px } #spin { width: 10px; height: 10px; animation: spin 1s linear infinite } @keyframes spin { to { transform: rotate(360deg) } }</style></head><body><div id="slide" data-track-id="slide"></div><div id="spin"></div><script>document.getElementById("slide").animate([{ transform: "translateX(0)" }, { transform: "translateX(100px)" }], { duration: 600, fill: "forwards" })</script></body></html>';

test(
  'infinite animations resume after the screenshot',
  { tag: '@ralph' },
  async ({ page, ralph }) => {
    await page.route('**/*', (route) =>
      route.fulfill({ contentType: 'text/html', body: animatedHtml }),
    );
    await page.goto('https://fixture.test/animated');
    await ralph.waitForCapture();
    expect(
      await page.evaluate(() =>
        document
          .getAnimations()
          .some((animation) => animation.playState === 'running'),
      ),
    ).toBe(true);
  },
);

test.describe('reduced motion', () => {
  test.use({
    ralphOptions: async ({ ralphOptions }, use) => {
      await use({ ...ralphOptions, reduceMotion: true });
    },
  });
  test(
    'reduced motion waits for animations',
    { tag: '@ralph' },
    async ({ page, ralph }) => {
      await page.route('**/*', (route) =>
        route.fulfill({ contentType: 'text/html', body: animatedHtml }),
      );
      await page.goto('https://fixture.test/reduced');
      expect(
        await page.evaluate(
          () => matchMedia('(prefers-reduced-motion: reduce)').matches,
        ),
      ).toBe(true);
      await ralph.waitForCapture();
    },
  );
  test('reduced motion only applies to Ralph tests', async ({ page }) => {
    expect(
      await page.evaluate(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
    ).toBe(false);
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
    await ralph.waitForCapture();
  },
);

nativeTest('native Playwright test', async () => {
  expect(2 + 2).toBe(4);
});
