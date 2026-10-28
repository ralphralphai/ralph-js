import type { Page } from '@playwright/test';

import { loadedImageHash, sha256 } from './image_responses';
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
  'line-height',
  'letter-spacing',
  'color',
  'background-color',
  'text-align',
  'text-transform',
];
// Each with its initial value. Unlike fonts these are not inherited, so a
// child that repeats its parent's padding really has that padding: they are
// kept when set at all, not when they differ from the parent's.
const UNINHERITED_PROPERTIES: Record<string, string> = {
  'padding-top': '0px',
  'padding-right': '0px',
  'padding-bottom': '0px',
  'padding-left': '0px',
  'margin-top': '0px',
  'margin-right': '0px',
  'margin-bottom': '0px',
  'margin-left': '0px',
  'row-gap': 'normal',
  'column-gap': 'normal',
  'justify-content': 'normal',
  'align-items': 'normal',
  'flex-direction': 'row',
  'grid-template-columns': 'none',
  order: '0',
  'border-width': '0px',
  'border-color': 'currentcolor',
  'border-radius': '0px',
  'box-shadow': 'none',
  opacity: '1',
  'text-decoration-line': 'none',
};
// Anything else takes its size from its text or its parent, which is reported
// as that change. An image has neither, so its size is the only sign it was
// resized.
const IMAGE_PROPERTIES: Record<string, string> = {
  width: 'auto',
  height: 'auto',
};
const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const ELEMENT_LOOKUP_TIMEOUT_MS = 2000;
// Marks a subtree whose text, links and images the server generates on every
// request, such as a blog listing or a price quote. The diff compares only its
// structure and styles.
const DYNAMIC_ATTRIBUTE = 'data-ralph-dynamic';
// Tracking pixels and hidden widget loaders (GTM, Stripe, chat) mount as
// iframes this small. Nobody sees them, and their content changes on every
// load.
const MIN_IFRAME_SIZE = 5;

type Box = { x: number; y: number; width: number; height: number };
type Offset = Pick<Box, 'x' | 'y'>;
type Edges = { left: number; top: number; right: number; bottom: number };
type Style = Record<string, string>;
type AriaNode = {
  role?: string;
  name?: string;
  ref?: string;
  box?: Box;
  style?: Style;
  imageHash?: string;
  dynamic?: boolean;
  children?: AriaChild[];
};
type AriaChild = AriaNode | string;
type ImageSource = { src: string } | { markup: string };
type ElementFacts = { style: Style; dynamic: boolean; image?: ImageSource };

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
  const clips = await readClips(page, placed);
  const visible = placed.flatMap((node) => {
    const kept = keepShown(node, viewport.width, clips, undefined);
    return kept === undefined ? [] : [kept];
  });
  // Generated refs do not resolve as `aria-ref=` locators, so the elements
  // are described while they still carry only Playwright's refs.
  const described = await Promise.all(
    visible.map((node) => describe(page, node, {}, false)),
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

function edgesOf(box: Box): Edges {
  return {
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
  };
}

function intersect(a: Edges | undefined, b: Edges): Edges {
  if (a === undefined) {
    return b;
  }
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

// Playwright rounds every box to whole pixels, so two rows that only touch
// can read as a pixel apart or a pixel overlapping.
const ROUNDING_SLACK = 1;

function sticksOut(inner: Box, outer: Box): boolean {
  return (
    inner.x < outer.x - ROUNDING_SLACK ||
    inner.y < outer.y - ROUNDING_SLACK ||
    inner.x + inner.width > outer.x + outer.width + ROUNDING_SLACK ||
    inner.y + inner.height > outer.y + outer.height + ROUNDING_SLACK
  );
}

function overlaps(a: Box, b: Box): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) >
      ROUNDING_SLACK &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >
      ROUNDING_SLACK
  );
}

function isOutside(box: Box, clip: Edges): boolean {
  return (
    box.x >= clip.right ||
    box.x + box.width <= clip.left ||
    box.y >= clip.bottom ||
    box.y + box.height <= clip.top
  );
}

/**
 * The area each element is clipped to by its ancestors' `overflow`, in
 * document space, by ref.
 *
 * The boxes are not clipped (the rows of a 448px scroll box run thousands of
 * pixels down the page), and reading an element's ancestors is a page round
 * trip. Only an element that may overflow one is read: a root, one sticking
 * out of its parent, or one running into its next sibling. The clipping
 * ancestor itself is often missing from the tree, since Playwright unwraps a
 * nameless wrapper with one child. Every other element takes its parent's
 * clip.
 */
async function readClips(
  page: Page,
  nodes: AriaNode[],
): Promise<Map<string, Edges>> {
  const candidates: { node: AriaNode; frame: Edges | undefined }[] = [];
  const visit = (
    node: AriaNode,
    parent: Box | undefined,
    next: AriaNode | undefined,
    frame: Edges | undefined,
  ) => {
    if (
      node.box !== undefined &&
      (parent === undefined ||
        sticksOut(node.box, parent) ||
        (next?.box !== undefined && overlaps(node.box, next.box)))
    ) {
      candidates.push({ node, frame });
    }

    const childFrame =
      node.role === 'iframe' && node.box !== undefined
        ? intersect(frame, edgesOf(node.box))
        : frame;
    const elements = (node.children ?? []).filter((child) => {
      return typeof child !== 'string';
    });
    elements.forEach((child, index) => {
      visit(child, node.box, elements[index + 1], childFrame);
    });
  };
  nodes.forEach((node, index) => {
    visit(node, undefined, nodes[index + 1], undefined);
  });

  const clips = await Promise.all(
    candidates.map(async ({ node, frame }): Promise<[string, Edges][]> => {
      const clip = await readClip(page, node);
      return clip === undefined || node.ref === undefined
        ? []
        : [[node.ref, intersect(frame, clip)]];
    }),
  );
  return new Map(clips.flat());
}

async function readClip(
  page: Page,
  node: AriaNode,
): Promise<Edges | undefined> {
  if (node.box === undefined || node.ref === undefined) {
    return undefined;
  }

  let read;
  try {
    read = await page.locator(`aria-ref=${node.ref}`).evaluate(
      (element) => {
        const clip = {
          left: -Infinity,
          top: -Infinity,
          right: Infinity,
          bottom: Infinity,
        };
        let position = getComputedStyle(element).position;
        // <body> and <html> pass their overflow to the viewport, which the
        // full-page screenshot does not clip.
        for (
          let ancestor = element.parentElement;
          ancestor !== null &&
          ancestor !== document.body &&
          ancestor !== document.documentElement;
          ancestor = ancestor.parentElement
        ) {
          if (position === 'fixed') {
            break;
          }

          const style = getComputedStyle(ancestor);
          // An absolute element escapes every ancestor below its containing
          // block, overflow included.
          if (
            position === 'absolute' &&
            style.position === 'static' &&
            style.transform === 'none'
          ) {
            continue;
          }

          position = style.position;
          const clipsX = style.overflowX !== 'visible';
          const clipsY = style.overflowY !== 'visible';
          // `overflow` does not apply to an inline box, whose client size is 0
          // and would otherwise clip everything inside it.
          if ((!clipsX && !clipsY) || style.display === 'inline') {
            continue;
          }

          // Content is clipped at the padding edge, inside the border and any
          // scrollbar.
          const rect = ancestor.getBoundingClientRect();
          const left = rect.left + ancestor.clientLeft;
          const top = rect.top + ancestor.clientTop;
          if (clipsX) {
            clip.left = Math.max(clip.left, left);
            clip.right = Math.min(clip.right, left + ancestor.clientWidth);
          }

          if (clipsY) {
            clip.top = Math.max(clip.top, top);
            clip.bottom = Math.min(clip.bottom, top + ancestor.clientHeight);
          }
        }
        const own = element.getBoundingClientRect();
        return { x: own.x, y: own.y, clip };
      },
      undefined,
      { timeout: ELEMENT_LOOKUP_TIMEOUT_MS },
    );
  } catch {
    return undefined;
  }

  // The page measures in its frame's viewport. The element's own box gives the
  // offset from there to document space, so iframes and scroll need no other
  // correction.
  const dx = node.box.x - read.x;
  const dy = node.box.y - read.y;
  return {
    left: read.clip.left + dx,
    top: read.clip.top + dy,
    right: read.clip.right + dx,
    bottom: read.clip.bottom + dy,
  };
}

// A positioned child can sit on screen while its wrapper's box does not, so a
// node is kept when it or any descendant is shown. One clipped out entirely
// is dropped with its descendants without walking them, because the ancestor
// that clips it clips them too.
function keepShown(
  node: AriaNode,
  viewportWidth: number,
  clips: Map<string, Edges>,
  inherited: Edges | undefined,
): AriaNode | undefined {
  if (
    node.role === 'iframe' &&
    node.box !== undefined &&
    (node.box.width < MIN_IFRAME_SIZE || node.box.height < MIN_IFRAME_SIZE)
  ) {
    return undefined;
  }

  const clip =
    (node.ref === undefined ? undefined : clips.get(node.ref)) ?? inherited;
  if (
    clip !== undefined &&
    node.box !== undefined &&
    isOutside(node.box, clip)
  ) {
    return undefined;
  }

  const shown = isShown(node, viewportWidth);
  const childClip =
    node.role === 'iframe' && node.box !== undefined
      ? intersect(clip, edgesOf(node.box))
      : clip;
  const children = (node.children ?? []).flatMap((child): AriaChild[] => {
    if (typeof child === 'string') {
      return shown ? [child] : [];
    }
    const kept = keepShown(child, viewportWidth, clips, childClip);
    return kept === undefined ? [] : [kept];
  });
  if (!shown && children.length === 0) {
    return undefined;
  }

  // Playwright unwraps a nameless generic with one child, but counts children
  // before the hidden ones are dropped here. A hidden sibling that comes and
  // goes, such as the 1px `alert` Next.js mounts in <body> once it hydrates,
  // would otherwise decide whether everything under the wrapper sits one level
  // deeper, and the diff then matches none of it across two captures.
  const [only] = children;
  if (
    node.role === 'generic' &&
    !node.name &&
    (node.children?.length ?? 0) > 1 &&
    children.length === 1 &&
    typeof only !== 'string' &&
    only?.ref !== undefined
  ) {
    return only;
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
      (element, { properties, isImage, dynamicAttribute }) => {
        const computed = getComputedStyle(element);
        // `getComputedStyle` resolves an `auto` margin to its used length, and
        // Chromium reports that length inconsistently: the same centered
        // element, laid out identically, reads `0px` on one load and `40px` on
        // the next. The typed computed value keeps it `auto`. Firefox has no
        // `computedStyleMap`.
        const typed =
          'computedStyleMap' in element
            ? element.computedStyleMap()
            : undefined;
        const style = Object.fromEntries(
          properties.map((property) => [
            property,
            property.startsWith('margin-') &&
            typed?.get(property)?.toString() === 'auto'
              ? 'auto'
              : computed.getPropertyValue(property),
          ]),
        );
        // `closest`, because the marked element need not be in the aria
        // tree: a plain wrapper `div` around a card often is not.
        const dynamic = element.closest(`[${dynamicAttribute}]`) !== null;

        if (!isImage) {
          return { style, dynamic };
        }

        if (element instanceof HTMLImageElement) {
          return {
            style,
            dynamic,
            image: { src: element.currentSrc || element.src },
          };
        }

        if (element instanceof SVGElement) {
          return { style, dynamic, image: { markup: element.outerHTML } };
        }

        const backgroundUrl = /url\("(.+)"\)/.exec(
          computed.backgroundImage,
        )?.[1];
        return backgroundUrl === undefined
          ? { style, dynamic }
          : {
              style,
              dynamic,
              image: { src: new URL(backgroundUrl, document.baseURI).href },
            };
      },
      {
        properties: [
          ...STYLE_PROPERTIES,
          ...Object.keys(UNINHERITED_PROPERTIES),
          ...(isImage ? Object.keys(IMAGE_PROPERTIES) : []),
        ],
        isImage,
        dynamicAttribute: DYNAMIC_ATTRIBUTE,
      },
      { timeout: ELEMENT_LOOKUP_TIMEOUT_MS },
    );
  } catch {
    return undefined;
  }
}

// The bytes are hashed rather than the url, so the same image moved to a new
// CDN path is not a change.
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

  return loadedImageHash(page, image.src);
}

// Fonts and color are inherited, so recording them on every element would
// turn one change on the body into a change on every element. Only what an
// element sets differently from its parent is kept, except the uninherited and
// image properties.
function distinctStyle(style: Style, inherited: Style): Style | undefined {
  const distinct = Object.entries(style).filter(([property, value]) => {
    // Computed, `currentcolor` is the text color, so without a border it
    // would record every element's color a second time.
    if (property === 'border-color') {
      return style['border-width'] !== '0px';
    }

    const initial =
      UNINHERITED_PROPERTIES[property] ?? IMAGE_PROPERTIES[property];
    if (initial !== undefined) {
      return value !== initial;
    }

    if (property === 'background-color' && value === TRANSPARENT) {
      return false;
    }
    return inherited[property] !== value;
  });
  return distinct.length === 0 ? undefined : Object.fromEntries(distinct);
}

// `dynamic` is recorded only at the top of a marked subtree, and the diff
// applies it to everything below, which keeps it off every descendant.
async function describe(
  page: Page,
  child: AriaChild,
  inherited: Style,
  insideDynamic: boolean,
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
  const dynamic = facts?.dynamic === true && !insideDynamic;
  const children =
    child.children === undefined
      ? undefined
      : await Promise.all(
          child.children.map((grandchild) =>
            describe(
              page,
              grandchild,
              facts?.style ?? inherited,
              insideDynamic || dynamic,
            ),
          ),
        );

  return {
    ...child,
    ...(style && { style }),
    ...(imageHash && { imageHash }),
    ...(dynamic && { dynamic }),
    ...(children && { children }),
  };
}
