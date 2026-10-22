import { createHash } from 'node:crypto';

import type { Page } from '@playwright/test';

import type { PageLayout } from './types';

// Mirrors the server's limits. A snapshot past them is left out rather than
// sent, so the node still uploads, without a snapshot to diff.
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_SNAPSHOT_JSON_DEPTH = 128;

// Each aria level is two JSON levels, the element and its `children` array,
// and a leaf's `box` and `style` add two more under the element.
const MAX_ARIA_DEPTH = Math.floor(MAX_SNAPSHOT_JSON_DEPTH / 2) - 2;

const STYLE_PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'color',
  'background-color',
];
const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const ELEMENT_LOOKUP_TIMEOUT_MS = 2000;

type Box = { x: number; y: number; width: number; height: number };
type Offset = Pick<Box, 'x' | 'y'>;
type Style = Record<string, string>;
type AriaNode = {
  role?: string;
  ref?: string;
  box?: Box;
  style?: Style;
  imageHash?: string;
  children?: AriaChild[];
};
type AriaChild = AriaNode | string;
type ImageSource = { src: string } | { markup: string };
type ElementFacts = { style: Style; image?: ImageSource };

/**
 * The page's aria tree as JSON, with each element's box in document
 * coordinates, its distinctive styles, and a hash of its image. Undefined when
 * the snapshot is past the server's limits.
 *
 * The page is not scrolled first, because scrolling changes the page the
 * screenshot just showed: sticky headers, lazy loading, scroll-triggered
 * animation.
 */
export async function captureAriaSnapshot(
  page: Page,
  { viewport, scroll }: Pick<PageLayout, 'viewport' | 'scroll'>,
): Promise<Buffer | undefined> {
  // The default mode drops unnamed `generic` wrappers, so a div-built page
  // comes out flat. `ai` mode keeps them, which preserves the DOM nesting.
  const snapshot = (await page.locator('body').ariaSnapshotJSON({
    mode: 'ai',
    boxes: true,
    depth: MAX_ARIA_DEPTH,
  })) as AriaNode[];

  const placed = await Promise.all(
    snapshot.map((node) => toDocument(page, node, scroll)),
  );
  const visible = placed.flatMap((node) => {
    const kept = keepShown(node, viewport.width);
    return kept === undefined ? [] : [kept];
  });
  // Generated refs do not resolve as `aria-ref=` locators, so the elements
  // are described while they still carry only Playwright's refs.
  const described = await Promise.all(
    visible.map((node) => describe(page, node, {})),
  );

  const json = Buffer.from(JSON.stringify(fillMissingRefs(described)));
  return json.byteLength > MAX_SNAPSHOT_BYTES ? undefined : json;
}

/**
 * Moves the viewport boxes Playwright reports into the full-page screenshot's
 * space. This has to happen before `keepShown`, which in viewport space would
 * drop everything scrolled above the viewport, and no later move brings those
 * back.
 *
 * An iframe's descendants are boxed in its own viewport, so they move by
 * where that viewport sits: the iframe's box plus its border and padding.
 */
async function toDocument(
  page: Page,
  node: AriaNode,
  offset: Offset,
): Promise<AriaNode> {
  const box = node.box && {
    ...node.box,
    x: node.box.x + offset.x,
    y: node.box.y + offset.y,
  };
  let childOffset = offset;
  if (node.role === 'iframe' && box !== undefined) {
    const inset = (node.ref === undefined
      ? undefined
      : await readContentInset(page, node.ref)) ?? { x: 0, y: 0 };
    childOffset = { x: box.x + inset.x, y: box.y + inset.y };
  }
  return {
    ...node,
    ...(box && { box }),
    ...(node.children && {
      children: await Promise.all(
        node.children.map((child) =>
          typeof child === 'string'
            ? child
            : toDocument(page, child, childOffset),
        ),
      ),
    }),
  };
}

// The iframe's viewport starts inside its border and padding.
async function readContentInset(
  page: Page,
  ref: string,
): Promise<Offset | undefined> {
  try {
    return await page.locator(`aria-ref=${ref}`).evaluate(
      (element) => {
        const computed = getComputedStyle(element);
        return {
          x: element.clientLeft + parseFloat(computed.paddingLeft),
          y: element.clientTop + parseFloat(computed.paddingTop),
        };
      },
      undefined,
      { timeout: ELEMENT_LOOKUP_TIMEOUT_MS },
    );
  } catch {
    return undefined;
  }
}

/**
 * In document space, the only boxes no scroll reveals are those past the left
 * or right of the viewport's width (a collapsed sidebar, an off-canvas menu)
 * or above the top of the document.
 */
function isReachable(box: Box | undefined, viewportWidth: number): boolean {
  if (box === undefined) {
    return false;
  }
  return (
    box.x < viewportWidth && box.x + box.width > 0 && box.y + box.height > 0
  );
}

// `ai` mode gives a ref only to an element with a non-empty box that receives
// pointer events, so a missing ref marks a zero-size, covered or
// `pointer-events: none` element.
function isShown(node: AriaNode, viewportWidth: number): boolean {
  return node.ref !== undefined && isReachable(node.box, viewportWidth);
}

// A positioned child can sit on screen while its wrapper's box does not, so a
// node is kept when it or any descendant is shown.
function keepShown(
  node: AriaNode,
  viewportWidth: number,
): AriaNode | undefined {
  const shown = isShown(node, viewportWidth);
  const children = (node.children ?? []).flatMap((child): AriaChild[] => {
    if (typeof child === 'string') {
      return shown ? [child] : [];
    }
    const kept = keepShown(child, viewportWidth);
    return kept === undefined ? [] : [kept];
  });
  if (!shown && children.length === 0) {
    return undefined;
  }
  return node.children === undefined ? node : { ...node, children };
}

// A wrapper kept only for its shown descendants has no Playwright ref, but
// every element needs an id to be diffed. The `n` prefix cannot collide with
// Playwright's `e14` / `f1e3` refs.
function fillMissingRefs(nodes: AriaChild[]): AriaChild[] {
  let generated = 0;
  const fill = (child: AriaChild): AriaChild => {
    if (typeof child === 'string') {
      return child;
    }
    generated += 1;
    const ref = child.ref ?? `n${generated}`;
    return child.children === undefined
      ? { ...child, ref }
      : { ...child, ref, children: child.children.map(fill) };
  };
  return nodes.map(fill);
}

async function readElement(
  page: Page,
  ref: string,
  isImage: boolean,
): Promise<ElementFacts | undefined> {
  try {
    return await page.locator(`aria-ref=${ref}`).evaluate(
      (element, { properties, isImage }) => {
        const computed = getComputedStyle(element);
        const style = Object.fromEntries(
          properties.map((property) => [
            property,
            computed.getPropertyValue(property),
          ]),
        );

        if (!isImage) {
          return { style };
        }

        if (element instanceof HTMLImageElement) {
          return { style, image: { src: element.currentSrc || element.src } };
        }

        if (element instanceof SVGElement) {
          return { style, image: { markup: element.outerHTML } };
        }

        const backgroundUrl = /url\("(.+)"\)/.exec(
          computed.backgroundImage,
        )?.[1];
        return backgroundUrl === undefined
          ? { style }
          : {
              style,
              image: { src: new URL(backgroundUrl, document.baseURI).href },
            };
      },
      { properties: STYLE_PROPERTIES, isImage },
      { timeout: ELEMENT_LOOKUP_TIMEOUT_MS },
    );
  } catch {
    return undefined;
  }
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// The bytes are hashed rather than the url, so the same image moved to a new
// CDN path is not a change. `page.request` shares the page's cookies without
// being bound by CORS, which a fetch from inside the page would be.
async function hashImage(
  page: Page,
  image: ImageSource,
): Promise<string | undefined> {
  if ('markup' in image) {
    return sha256(image.markup);
  }

  if (image.src === '') {
    return undefined;
  }

  if (image.src.startsWith('data:')) {
    return sha256(image.src);
  }

  try {
    const response = await page.request.get(image.src);
    // Only the hash is kept, so the body is not left in the request context.
    try {
      return response.ok() ? sha256(await response.body()) : undefined;
    } finally {
      await response.dispose();
    }
  } catch {
    return undefined;
  }
}

// Fonts and color are inherited, so recording them on every element would
// turn one change on the body into a change on every element. Only what an
// element sets differently from its parent is kept.
function distinctStyle(style: Style, inherited: Style): Style | undefined {
  const distinct = Object.entries(style).filter(([property, value]) => {
    if (property === 'background-color' && value === TRANSPARENT) {
      return false;
    }
    return inherited[property] !== value;
  });
  return distinct.length === 0 ? undefined : Object.fromEntries(distinct);
}

async function describe(
  page: Page,
  child: AriaChild,
  inherited: Style,
): Promise<AriaChild> {
  if (typeof child === 'string') {
    return child;
  }

  const facts =
    child.ref === undefined
      ? undefined
      : await readElement(page, child.ref, child.role === 'img');
  const style =
    facts === undefined ? undefined : distinctStyle(facts.style, inherited);
  const imageHash =
    facts?.image === undefined ? undefined : await hashImage(page, facts.image);
  const children =
    child.children === undefined
      ? undefined
      : await Promise.all(
          child.children.map((grandchild) =>
            describe(page, grandchild, facts?.style ?? inherited),
          ),
        );

  return {
    ...child,
    ...(style && { style }),
    ...(imageHash && { imageHash }),
    ...(children && { children }),
  };
}
