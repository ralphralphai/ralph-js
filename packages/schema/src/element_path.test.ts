import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { elementPath } from '@/element_path';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

// Through `locator.evaluate`, as the reporter calls it, so a helper left
// outside the function fails here rather than in a customer's run.
const pathOf = async (html: string, selector: string) => {
  await page.setContent(html);
  return page.locator(selector).evaluate(elementPath);
};

describe('elementPath', () => {
  it('resolves a click inside a control to the control', async () => {
    expect(
      await pathOf(
        '<main><div><div><button><span id="s">Start <b>trial</b></span></button></div></div></main>',
        'b',
      ),
    ).toBe('v1:main:1>div:1>div:1>button:1');
  });

  it('is null outside any interactive element', async () => {
    expect(await pathOf('<main><p>Hello</p></main>', 'p')).toBeNull();
  });

  it('counts same-tag siblings only', async () => {
    expect(
      await pathOf(
        '<main><p></p><button>a</button><span></span><button>b</button></main>',
        'button >> nth=1',
      ),
    ).toBe('v1:main:1>button:2');
  });

  it('anchors on an authored id and skips generated ones', async () => {
    const html = (id: string) => {
      return `<main><section id="${id}"><div><a href="/plans">Plans</a></div></section></main>`;
    };

    expect(await pathOf(html('pricing-table'), 'a')).toBe(
      'v1:#pricing-table>div:1>a:1',
    );

    for (const generated of [
      ':r1:',
      '«r1»',
      '_r_1_',
      'radix-_R_2b_',
      'el-20251024',
      'c-9f2c41d0aa',
    ]) {
      expect(await pathOf(html(generated), 'a')).toBe(
        'v1:main:1>section:1>div:1>a:1',
      );
    }
  });

  it('skips an id the page repeats', async () => {
    expect(
      await pathOf(
        '<main><div id="card"><button>a</button></div><div id="card"><button>b</button></div></main>',
        'button >> nth=1',
      ),
    ).toBe('v1:main:1>div:2>button:1');
  });

  it('anchors on a tracked container, numbering repeats', async () => {
    expect(
      await pathOf(
        '<main><div data-track-id="plan"><a href="/a">a</a></div><div data-track-id="plan"><div><a href="/b">b</a></div></div></main>',
        'a >> nth=1',
      ),
    ).toBe('v1:[plan]:2>div:1>a:1');
  });

  it('numbers landmarks of the same role across the page', async () => {
    const html =
      '<header><nav><a href="/">Home</a></nav></header><main><nav aria-label="side"><a href="/faq">FAQ</a></nav></main>';
    expect(await pathOf(html, 'a >> nth=0')).toBe('v1:navigation:1>a:1');
    expect(await pathOf(html, 'a >> nth=1')).toBe('v1:navigation:2>a:1');
  });

  it('treats header and footer as landmarks only outside a section', async () => {
    expect(
      await pathOf(
        '<div><footer><a href="/terms">Terms</a></footer></div>',
        'a',
      ),
    ).toBe('v1:contentinfo:1>a:1');
    expect(
      await pathOf(
        '<main><article><header><a href="/x">x</a></header></article></main>',
        'a',
      ),
    ).toBe('v1:main:1>article:1>header:1>a:1');
  });

  it('honours explicit landmark and control roles', async () => {
    expect(
      await pathOf(
        '<div role="dialog"><div><div role="button" tabindex="0"><svg></svg></div></div></div>',
        'svg',
      ),
    ).toBe('v1:dialog:1>div:1>div:1');
  });

  it('falls back to the body', async () => {
    expect(
      await pathOf(
        '<div><div></div><div><button>Go</button></div></div>',
        'button',
      ),
    ).toBe('v1:body>div:1>div:2>button:1');
  });

  it('keeps its path when the page changes outside the anchor', async () => {
    const before = await pathOf(
      '<main><div><button>Buy</button></div></main>',
      'button',
    );
    const after = await pathOf(
      '<div class="cookie-banner"><button>Accept</button></div><main><div><button>Buy</button></div></main>',
      'main button',
    );
    expect(after).toBe(before);
  });

  it('crosses into a shadow root', async () => {
    await page.setContent(
      '<main><div id="host-wrap"><x-widget></x-widget></div></main>',
    );
    await page.evaluate(() => {
      const host = document.querySelector('x-widget');
      host
        ?.attachShadow({ mode: 'open' })
        .append(document.createElement('div'));
      host?.shadowRoot?.firstElementChild?.append(
        document.createElement('button'),
      );
    });
    expect(await page.locator('x-widget button').evaluate(elementPath)).toBe(
      'v1:#host-wrap>x-widget:1>div:1>button:1',
    );
  });

  it('gives up past the step limit', async () => {
    const nested = `${'<div>'.repeat(80)}<button>deep</button>${'</div>'.repeat(80)}`;
    expect(await pathOf(nested, 'button')).toBeNull();
  });
});
