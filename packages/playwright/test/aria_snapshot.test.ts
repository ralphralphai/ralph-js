import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { captureAriaSnapshot } from '../src/aria_snapshot';
import { readLayout } from '../src/layout';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

// A page per capture, as in a real run: Playwright numbers refs per page.
const snapshotOf = async (html: string) => {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  try {
    await page.setContent(html);
    const layout = await readLayout(page);
    return JSON.parse(String(await captureAriaSnapshot(page, layout))) as {
      role: string;
    }[];
  } finally {
    await page.close();
  }
};

it('captures the same tree whether or not a hidden sibling has mounted yet', async () => {
  const content =
    '<main><h1>Title</h1><p>Body text</p><a href="/x">Link</a></main>';
  const before = await snapshotOf(`<body>${content}</body>`);
  // What Next.js mounts in <body> once it hydrates.
  const after = await snapshotOf(
    `<body>${content}<div role="alert" style="position:absolute;left:-1px;top:0;width:1px;height:1px;overflow:hidden"></div></body>`,
  );
  expect(after.map(({ role }) => role)).toEqual(['main']);
  expect(after).toEqual(before);
});
