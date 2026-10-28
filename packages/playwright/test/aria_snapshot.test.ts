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

type Node = {
  role?: string;
  name?: string;
  text?: string;
  children?: (Node | string)[];
};

const namesWithRole = (nodes: (Node | string)[], role: string): string[] => {
  return nodes.flatMap((node) => {
    if (typeof node === 'string') {
      return [];
    }
    const own = node.role === role ? [node.name || node.text || ''] : [];
    return [...own, ...namesWithRole(node.children ?? [], role)];
  });
};

it('leaves out the rows a scroll box hides below its fold', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => {
    return `<li style="height:20px">Row ${index}</li>`;
  }).join('');
  const snapshot = await snapshotOf(
    `<body><div style="height:60px;overflow:auto"><ul style="margin:0">${rows}</ul></div></body>`,
  );
  expect(namesWithRole(snapshot as Node[], 'listitem')).toEqual([
    'Row 0',
    'Row 1',
    'Row 2',
  ]);
});

it('leaves out the slides a carousel hides inside the viewport', async () => {
  const snapshot = await snapshotOf(
    `<body><div style="width:200px;overflow:hidden"><div style="display:flex;width:600px">
      <button style="width:200px;flex:none">One</button>
      <button style="width:200px;flex:none">Two</button>
      <button style="width:200px;flex:none">Three</button>
    </div></div></body>`,
  );
  expect(namesWithRole(snapshot as Node[], 'button')).toEqual(['One']);
});

it('keeps content past an axis the box does not clip', async () => {
  const snapshot = await snapshotOf(
    `<body><div style="height:40px;overflow-x:clip">
      <button style="display:block;height:30px">One</button>
      <button style="display:block;height:30px">Two</button>
    </div></body>`,
  );
  expect(namesWithRole(snapshot as Node[], 'button')).toEqual(['One', 'Two']);
});
