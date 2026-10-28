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
const snapshotOf = async (html: string, ignore?: string[]) => {
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  try {
    await page.setContent(html);
    const layout = await readLayout(page);
    return JSON.parse(
      String(await captureAriaSnapshot(page, layout, ignore)),
    ) as Node[];
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
  style?: Record<string, string>;
  dynamic?: boolean;
  children?: (Node | string)[];
};

const withoutRefs = (nodes: Node[]) =>
  JSON.parse(JSON.stringify(nodes), (key, value: unknown) =>
    key === 'ref' ? undefined : value,
  ) as Node[];

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

it('leaves out the subtrees ignoreInDiff matches', async () => {
  const snapshot = await snapshotOf(
    `<body>
      <button>Keep</button>
      <div class="ad"><button>Ad one</button><a href="/ad">Ad link</a></div>
      <button id="promo">Promo</button>
    </body>`,
    ['.ad', '#promo'],
  );
  expect(namesWithRole(snapshot as Node[], 'button')).toEqual(['Keep']);
  expect(namesWithRole(snapshot as Node[], 'link')).toEqual([]);
});

it('ignores inside an open shadow root under a matched host', async () => {
  const snapshot = await snapshotOf(
    `<body><button>Keep</button><chat-widget></chat-widget>
      <script>
        const host = document.querySelector('chat-widget');
        host.attachShadow({ mode: 'open' }).innerHTML = '<button>Chat</button>';
      </script>
    </body>`,
    ['chat-widget'],
  );
  expect(namesWithRole(snapshot as Node[], 'button')).toEqual(['Keep']);
});

it('captures the same tree whether or not the ignored content is there', async () => {
  const content = '<h1>Title</h1><p>Body text</p>';
  const without = await snapshotOf(
    `<body><main><div>${content}</div></main></body>`,
    ['.ad'],
  );
  const withAd = await snapshotOf(
    `<body><main><div>${content}<div class="ad"><button>Buy</button><button>Now</button></div></div></main></body>`,
    ['.ad'],
  );
  // The boxes differ, since the ad takes up space on the page, and so do the
  // refs, which Playwright numbers in the order it first sees each element.
  const shape = (nodes: unknown) =>
    JSON.parse(JSON.stringify(nodes), (key, value: unknown) =>
      key === 'box' || key === 'ref' ? undefined : value,
    ) as unknown;
  expect(shape(withAd)).toEqual(shape(without));
});

it.each(['red', 'blue'])(
  'preserves inherited %s styles when ignoring a sibling',
  async (color) => {
    const content = '<main><h1>Title</h1></main>';
    const without = await snapshotOf(
      `<body style="color:${color}">${content}</body>`,
      ['.ad'],
    );
    const withAd = await snapshotOf(
      `<body style="color:${color}">${content}<button class="ad">Ad</button></body>`,
      ['.ad'],
    );
    expect(withAd[0]?.role).toBe('main');
    expect(withAd[0]?.style?.color).toBe(
      color === 'red' ? 'rgb(255, 0, 0)' : 'rgb(0, 0, 255)',
    );
    expect(withoutRefs(withAd)).toEqual(withoutRefs(without));
  },
);

it('preserves a dynamic ancestor when ignoring a sibling', async () => {
  const content = '<main><h1>Title</h1></main>';
  const without = await snapshotOf(
    `<body data-ralph-dynamic>${content}</body>`,
    ['.ad'],
  );
  const withAd = await snapshotOf(
    `<body data-ralph-dynamic>${content}<button class="ad">Ad</button></body>`,
    ['.ad'],
  );
  expect(withAd[0]?.role).toBe('main');
  expect(withAd[0]?.dynamic).toBe(true);
  expect(withoutRefs(withAd)).toEqual(withoutRefs(without));
});

it('drops unnamed wrappers emptied by ignored children without changing geometry', async () => {
  const capture = (count: number) =>
    snapshotOf(
      `<body><div style="height:80px">${'<button class="ad">Ad</button>'.repeat(count)}</div><main><h1>Title</h1></main></body>`,
      ['.ad'],
    );
  const empty = await capture(0);
  expect(withoutRefs(await capture(1))).toEqual(withoutRefs(empty));
  expect(withoutRefs(await capture(2))).toEqual(withoutRefs(empty));
});

it('keeps a semantic wrapper when all of its children are ignored', async () => {
  const snapshot = await snapshotOf(
    '<body><section aria-label="Offers"><button class="ad">Ad</button><button class="ad">Promo</button></section></body>',
    ['.ad'],
  );
  expect(namesWithRole(snapshot, 'region')).toEqual(['Offers']);
  expect(namesWithRole(snapshot, 'button')).toEqual([]);
});

it.each([
  '<button slot="ad">Ad</button>',
  '<div slot="ad"><button>Ad</button></div>',
])(
  'ignores slotted content in a matched shadow wrapper: %s',
  async (content) => {
    const snapshot = await snapshotOf(
      `<body><ad-widget>${content}<button slot="keep">Keep</button></ad-widget>
      <script>
        document.querySelector('ad-widget').attachShadow({ mode: 'open' }).innerHTML =
          '<div class="ad"><slot name="ad"></slot></div><slot name="keep"></slot>';
      </script>
    </body>`,
      ['.ad'],
    );
    expect(namesWithRole(snapshot, 'button')).toEqual(['Keep']);
  },
);

it('ignores matches inside an iframe', async () => {
  const frame =
    '<button>Inside</button><div class="ad"><button>Ad</button></div>';
  const snapshot = await snapshotOf(
    `<body><button>Keep</button><iframe style="width:300px;height:150px" srcdoc='${frame}'></iframe></body>`,
    ['.ad'],
  );
  expect(namesWithRole(snapshot as Node[], 'button')).toEqual([
    'Keep',
    'Inside',
  ]);
});

it('ignores an iframe and everything in it', async () => {
  const snapshot = await snapshotOf(
    `<body><button>Keep</button><iframe class="widget" style="width:300px;height:150px" srcdoc="<button>Inside</button>"></iframe></body>`,
    ['.widget'],
  );
  expect(namesWithRole(snapshot as Node[], 'button')).toEqual(['Keep']);
  expect(namesWithRole(snapshot as Node[], 'iframe')).toEqual([]);
});

it('ignores a match whose name changes while it is captured', async () => {
  // Renamed every millisecond, so its text differs between reads.
  const snapshot = await snapshotOf(
    `<body><button>Keep</button><div class="clock"><button>0</button></div>
      <script>
        const button = document.querySelector('.clock button');
        let tick = 0;
        setInterval(() => { button.textContent = String(++tick); }, 1);
      </script>
    </body>`,
    ['.clock'],
  );
  expect(namesWithRole(snapshot as Node[], 'button')).toEqual(['Keep']);
});
