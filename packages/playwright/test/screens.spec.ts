import { test, expect } from '../dist/index.mjs';

test.beforeEach(async ({ context }) => {
  await context.route('https://fixture.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>screen</p>' }),
  );
});

test('every screen size', { tag: '@ralph' }, async ({ page, ralph }) => {
  await page.goto('https://fixture.test/all');
  await ralph.waitForCapture();
});

test(
  'mobile only',
  { tag: ['@ralph', '@ralph-screen:375x812'] },
  async ({ page, ralph }) => {
    await page.goto('https://fixture.test/mobile');
    await ralph.waitForCapture();
  },
);

test(
  'tablet and desktop',
  { tag: ['@ralph', '@ralph-screen:768x1024', '@ralph-screen:1280x720'] },
  async ({ page, ralph }) => {
    await page.goto('https://fixture.test/wide');
    await ralph.waitForCapture();
  },
);

test.describe('desktop group', { tag: '@ralph-screen:1280x720' }, () => {
  test('desktop only', { tag: '@ralph' }, async ({ page, ralph }) => {
    await page.goto('https://fixture.test/desktop');
    await ralph.waitForCapture();
  });
});

test('unknown screen size', { tag: '@ralph-screen:1x1' }, async () => {});

test(
  'unrecorded tests are filtered too',
  { tag: '@ralph-screen:375x812' },
  async ({ page }) => {
    expect(page.viewportSize()).toEqual({ width: 375, height: 812 });
  },
);
