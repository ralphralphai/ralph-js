import { setTimeout as delay } from 'node:timers/promises';

import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { captureAriaSnapshot } from '../src/aria_snapshot';
import { CaptureFreezer } from '../src/capture_freezer';
import { takeScreenshot } from '../src/image';
import { readLayout } from '../src/layout';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

const html = `<!doctype html>
<style>
  body { margin: 0; background: white }
  button { position: absolute; left: 20px; top: 20px; width: 40px; height: 40px; border: 0; background: red; color: red }
  @keyframes move { to { transform: translateX(80px) } }
  .animated { width: 10px; height: 10px; animation: move 5s linear infinite }
  #paused { animation-play-state: paused }
</style>
<button data-track-id="moving">Moving</button>
<div class="animated"></div><div id="paused" class="animated"></div>
<div id="shadow"></div>
<script>
  let ticks = 0;
  let frames = 0;
  setInterval(() => {
    document.body.dataset.ticks = String(++ticks);
    document.querySelector('button').style.left = (20 + ticks % 100) + 'px';
  }, 10);
  function draw() {
    document.body.dataset.frames = String(++frames);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  const shadow = document.getElementById('shadow').attachShadow({mode: 'open'});
  shadow.innerHTML = '<div>Shadow</div>';
  shadow.querySelector('div').animate([{opacity: 0.2}, {opacity: 1}], {duration: 1000, iterations: Infinity});
</script>`;

const readState = (page: Page) =>
  page.evaluate(() => ({
    ticks: Number(document.body.dataset.ticks),
    frames: Number(document.body.dataset.frames),
    time: Date.now(),
    performance: performance.now(),
    animations: document
      .getAnimations()
      .map((animation) => animation.currentTime),
    shadow: document
      .getElementById('shadow')!
      .shadowRoot!.getAnimations()
      .map((animation) => animation.currentTime),
  }));

async function fixture() {
  const context = await browser.newContext({
    viewport: { width: 400, height: 200 },
  });
  const freezer = new CaptureFreezer(context);
  await freezer.install();
  const page = await context.newPage();
  await page.setContent(html);
  await delay(60);
  return { context, freezer, page };
}

it('holds timers, animation frames, CSS and shadow animations through screenshot and snapshot, then resumes', async () => {
  const { context, freezer, page } = await fixture();
  try {
    for (let capture = 0; capture < 2; capture++) {
      await freezer.capture(page, new AbortController().signal, async () => {
        const before = await readState(page);
        const layout = await readLayout(page);
        const image = await takeScreenshot(page, Date.now() + 3000, true);
        const snapshot = await captureAriaSnapshot(page, layout);
        await delay(120);
        expect(await readState(page)).toEqual(before);
        const moving = layout.trackedElements.find(
          (item) => item.trackId === 'moving',
        )!;
        expect(snapshot).toBeDefined();
        expect(snapshot!.toString()).toContain(
          `"box":{"x":${moving.x},"y":20,"width":40,"height":40}`,
        );
        // Compare the actual screenshot's red rectangle to the captured box.
        const left = await page.evaluate(async (base64) => {
          const image = new Image();
          image.src = `data:image/webp;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          const { data } = ctx.getImageData(0, 40, canvas.width, 1);
          for (let x = 0; x < canvas.width; x++) {
            if (data[x * 4]! > 180 && data[x * 4 + 1]! < 80) {
              return x;
            }
          }
          return -1;
        }, image.bytes.toString('base64'));
        expect(Math.abs(left - moving.x)).toBeLessThanOrEqual(1);
      });
      const resumed = await readState(page);
      await delay(80);
      const later = await readState(page);
      expect(later.ticks).toBeGreaterThan(resumed.ticks);
      expect(later.frames).toBeGreaterThan(resumed.frames);
      expect(later.animations[0]).toBeGreaterThan(
        resumed.animations[0] as number,
      );
      expect(later.shadow[0]).toBeGreaterThan(resumed.shadow[0] as number);
      expect(
        await page
          .locator('#paused')
          .evaluate((element) => element.getAnimations()[0]!.playState),
      ).toBe('paused');
    }
  } finally {
    await context.close();
  }
});

it('finishes finite animations instead of pausing them midway', async () => {
  const { context, freezer } = await fixture();
  try {
    // A page of its own: `setContent` keeps the fixture page's timers running.
    const page = await context.newPage();
    await page.setContent(`<!doctype html>
<style>
  @keyframes slide { from { transform: translateX(0) } to { transform: translateX(100px) } }
  #finite { width: 10px; height: 10px; animation: slide 10s linear }
  #delayed { width: 10px; height: 10px; animation: slide 1s linear 10s both }
  #infinite { width: 10px; height: 10px; animation: slide 10s linear infinite }
</style>
<div id="finite"></div><div id="delayed"></div><div id="infinite"></div>`);
    await delay(60);
    const read = (id: string) =>
      page.locator(`#${id}`).evaluate((element) => ({
        transform: getComputedStyle(element).transform,
        playState: element.getAnimations()[0]?.playState,
      }));
    await freezer.capture(page, new AbortController().signal, async () => {
      // Finished without a fill, the animation is gone and the element is
      // back to its own style, as it will be once the animation ends.
      expect(await read('finite')).toEqual({
        transform: 'none',
        playState: undefined,
      });
      expect(await read('delayed')).toEqual({
        transform: 'matrix(1, 0, 0, 1, 100, 0)',
        playState: 'finished',
      });
      expect((await read('infinite')).playState).toBe('paused');
    });
    expect((await read('finite')).playState).toBeUndefined();
    expect((await read('infinite')).playState).toBe('running');
  } finally {
    await context.close();
  }
});

it.each(['error', 'abort', 'navigation', 'close'] as const)(
  'resumes the context after capture %s',
  async (outcome) => {
    const { context, freezer, page } = await fixture();
    const sibling = await context.newPage();
    await sibling.setContent(html);
    const abort = new AbortController();
    try {
      const task = freezer.capture(page, abort.signal, async () => {
        if (outcome === 'error') {
          throw new Error('capture failed');
        }
        if (outcome === 'abort') {
          abort.abort(new Error('capture timed out'));
          abort.signal.throwIfAborted();
        }
        if (outcome === 'navigation') {
          await page.goto(`data:text/html,${encodeURIComponent(html)}`);
        }
        if (outcome === 'close') {
          await page.close();
        }
      });
      if (outcome === 'error' || outcome === 'abort') {
        await expect(task).rejects.toThrow(/capture (failed|timed out)/);
        expect(
          await page.evaluate(() => document.getAnimations()[0]!.playState),
        ).toBe('running');
      } else {
        await task;
      }
      const resumed = await readState(sibling);
      await delay(80);
      expect((await readState(sibling)).ticks).toBeGreaterThan(resumed.ticks);
      // Cleanup also releases the queue after an error.
      await freezer.capture(
        sibling,
        new AbortController().signal,
        async () => {},
      );
    } finally {
      await context.close();
    }
  },
);

it('serializes captures across tabs and skips a queued capture whose deadline expired', async () => {
  const { context, freezer, page } = await fixture();
  const sibling = await context.newPage();
  await sibling.setContent(html);
  const events: string[] = [];
  const abort = new AbortController();
  try {
    const first = freezer.capture(
      page,
      new AbortController().signal,
      async () => {
        events.push('first starts');
        const state = await readState(page);
        abort.abort(new Error('queued timeout'));
        await delay(120);
        expect(await readState(page)).toEqual(state);
        events.push('first ends');
      },
    );
    const expired = freezer.capture(sibling, abort.signal, async () => {
      events.push('expired capture ran');
    });
    const expiredResult = expect(expired).rejects.toThrow('queued timeout');
    const second = freezer.capture(
      sibling,
      new AbortController().signal,
      async () => {
        events.push('second starts');
        const state = await readState(sibling);
        await delay(80);
        expect(await readState(sibling)).toEqual(state);
      },
    );
    await Promise.all([first, expiredResult, second]);
    expect(events).toEqual(['first starts', 'first ends', 'second starts']);
  } finally {
    await context.close();
  }
});

it('does not install fake timers into an already loaded custom context', async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('data:text/html,<p>Already loaded</p>');
    expect(() => new CaptureFreezer(context).install()).toThrow(
      'Await ralph.observe(context)',
    );
    expect(await page.evaluate(() => setTimeout.toString())).toContain(
      '[native code]',
    );
  } finally {
    await context.close();
  }
});

it('freezes timers and animations in a cross-origin iframe', async () => {
  const { context, freezer, page } = await fixture();
  try {
    await context.route('https://frame.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    const loaded = page.waitForEvent('framenavigated', {
      predicate: (frame) => frame.url() === 'https://frame.test/',
    });
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = 'https://frame.test/';
      document.body.append(frame);
    });
    const frame = await loaded;
    await frame.waitForLoadState();
    const read = () =>
      frame.evaluate(() => ({
        ticks: Number(document.body.dataset.ticks),
        frames: Number(document.body.dataset.frames),
        animation: document.getAnimations()[0]!.currentTime,
      }));
    await freezer.capture(page, new AbortController().signal, async () => {
      const before = await read();
      await delay(120);
      expect(await read()).toEqual(before);
    });
    const resumed = await read();
    await delay(80);
    expect((await read()).ticks).toBeGreaterThan(resumed.ticks);
    expect(
      await frame.evaluate(() => document.getAnimations()[0]!.playState),
    ).toBe('running');
  } finally {
    await context.close();
  }
});

it('retries a pause command that reaches the browser after its target time', async () => {
  const { context, freezer, page } = await fixture();
  const pauseAt = context.clock.pauseAt.bind(context.clock);
  let calls = 0;
  context.clock.pauseAt = async (time) => {
    if (++calls === 1) {
      await delay(150);
    }
    await pauseAt(time);
  };
  try {
    await freezer.capture(page, new AbortController().signal, async () => {
      const before = await readState(page);
      await delay(80);
      expect(await readState(page)).toEqual(before);
    });
    expect(calls).toBe(2);
    const resumed = await readState(page);
    await delay(80);
    expect((await readState(page)).ticks).toBeGreaterThan(resumed.ticks);
  } finally {
    await context.close();
  }
});

it('finishes a pending pause before cleaning up after a deadline', async () => {
  const { context, freezer, page } = await fixture();
  const abort = new AbortController();
  const pauseAt = context.clock.pauseAt.bind(context.clock);
  let pauseCompleted = false;
  let captured = false;
  context.clock.pauseAt = async (time) => {
    await pauseAt(time);
    abort.abort(new Error('deadline expired during pause'));
    await delay(80);
    pauseCompleted = true;
  };
  try {
    await expect(
      freezer.capture(page, abort.signal, async () => {
        captured = true;
      }),
    ).rejects.toThrow('deadline expired during pause');
    expect(pauseCompleted).toBe(true);
    expect(captured).toBe(false);
    const resumed = await readState(page);
    await delay(80);
    expect((await readState(page)).ticks).toBeGreaterThan(resumed.ticks);
  } finally {
    await context.close();
  }
});

it('resumes animations and timers when their readiness wait outlives the deadline', async () => {
  const { context, freezer, page } = await fixture();
  const abort = new AbortController();
  let captured = false;
  try {
    await page.exposeFunction('captureWaitingForReady', () => {
      abort.abort(new Error('deadline expired waiting for animations'));
    });
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        Object.defineProperty(animation, 'ready', {
          get() {
            void (
              window as unknown as {
                captureWaitingForReady: () => Promise<void>;
              }
            ).captureWaitingForReady();
            // Simulate a pause that cannot finish before the deadline.
            return new Promise(() => {});
          },
        });
      }
    });
    await expect(
      freezer.capture(page, abort.signal, async () => {
        captured = true;
      }),
    ).rejects.toThrow('deadline expired waiting for animations');
    expect(captured).toBe(false);
    expect(
      await page.evaluate(() => document.getAnimations()[0]!.playState),
    ).toBe('running');
    const resumed = await readState(page);
    await delay(80);
    expect((await readState(page)).ticks).toBeGreaterThan(resumed.ticks);
  } finally {
    await context.close();
  }
});
