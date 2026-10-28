/**
 * Where a click landed in the DOM: the nearest interactive element, as the tag
 * and `nth-of-type` of each step down from its nearest stable ancestor.
 *
 * ```
 * v1:#pricing-table>div:2>button:1
 * v1:[hero-cta]:1>div:1>a:1
 * v1:navigation:2>ul:1>li:3>a:1
 * v1:body>div:1>div:4>button:2
 * ```
 *
 * The tracker records it on a click, and the Playwright reporter runs the same
 * function on every interactive element of a snapshot, so a click and the
 * element it landed on carry equal strings exactly when both came from the same
 * DOM. Classes, attributes and text are left out: the anchor and positions
 * already identify the element, and those are what restyles and visitors change.
 *
 * Self-contained, with every helper inside, because the reporter passes it to
 * `locator.evaluate`, which sends the function's source to the page.
 *
 * `null` for a click outside any interactive element, or a path past the limits.
 */
export function elementPath(clicked: Element): string | null {
  const MAX_STEPS = 64;
  const MAX_LENGTH = 1_024;
  const INTERACTIVE = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    'label',
    ...[
      'button',
      'link',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'combobox',
      'textbox',
      'searchbox',
      'slider',
      'spinbutton',
      'treeitem',
    ].map((role) => {
      return `[role~="${role}"]`;
    }),
  ].join(',');
  const LANDMARK_ROLES = new Set([
    'banner',
    'complementary',
    'contentinfo',
    'dialog',
    'alertdialog',
    'form',
    'main',
    'navigation',
    'search',
  ]);
  const LANDMARK_TAGS: Record<string, string> = {
    aside: 'complementary',
    dialog: 'dialog',
    form: 'form',
    main: 'main',
    nav: 'navigation',
    search: 'search',
  };
  const LANDMARK_SELECTOR = [
    ...Object.keys(LANDMARK_TAGS),
    'header',
    'footer',
    '[role]',
  ].join(',');

  const target = clicked.closest(INTERACTIVE);
  if (target === null) {
    return null;
  }

  const parentOf = (element: Element): Element | null => {
    if (element.parentElement !== null) {
      return element.parentElement;
    }

    const root = element.parentNode;
    return root instanceof ShadowRoot ? root.host : null;
  };

  // A banner or contentinfo only when not scoped to a section of the page, the
  // rule the browser uses for `header` and `footer`.
  const isSectioned = (element: Element): boolean => {
    return (
      parentOf(element)?.closest('article, aside, main, nav, section') != null
    );
  };

  const landmarkRole = (element: Element): string | null => {
    const role = element.getAttribute('role')?.trim().split(/\s+/)[0];
    if (role !== undefined && role !== '') {
      return LANDMARK_ROLES.has(role) ? role : null;
    }

    const tag = element.localName;
    if (tag === 'header' || tag === 'footer') {
      if (isSectioned(element)) {
        return null;
      }

      return tag === 'header' ? 'banner' : 'contentinfo';
    }

    return LANDMARK_TAGS[tag] ?? null;
  };

  // Framework-generated ids change between renders and builds: React's
  // `:r1:`, `«r1»` and `_r_1_`, and anything carrying a counter or a hash.
  const isAuthoredId = (id: string): boolean => {
    return !(
      id === '' ||
      /[:«»]/.test(id) ||
      /_[rR]_/.test(id) ||
      /\d{4,}/.test(id) ||
      /[0-9a-f]{8,}/i.test(id)
    );
  };

  const ordinalAmong = (element: Element, matches: Element[]): number => {
    return matches.indexOf(element) + 1;
  };

  const anchorOf = (element: Element): string | null => {
    const root = element.getRootNode() as Document | ShadowRoot;
    const trackId = element.getAttribute('data-track-id');
    if (trackId !== null && trackId !== '') {
      const tracked = Array.from(
        root.querySelectorAll('[data-track-id]'),
      ).filter((candidate) => {
        return candidate.getAttribute('data-track-id') === trackId;
      });
      return `[${encodeURIComponent(trackId)}]:${ordinalAmong(element, tracked)}`;
    }

    if (
      element.id !== '' &&
      isAuthoredId(element.id) &&
      root.querySelectorAll(`[id="${CSS.escape(element.id)}"]`).length === 1
    ) {
      return `#${encodeURIComponent(element.id)}`;
    }

    const landmark = landmarkRole(element);
    if (landmark !== null) {
      const same = Array.from(root.querySelectorAll(LANDMARK_SELECTOR)).filter(
        (candidate) => {
          return landmarkRole(candidate) === landmark;
        },
      );
      return `${landmark}:${ordinalAmong(element, same)}`;
    }

    return element.localName === 'body' ? 'body' : null;
  };

  const steps: string[] = [];
  let anchor: string | null = null;
  for (
    let element: Element | null = target;
    element !== null;
    element = parentOf(element)
  ) {
    anchor = anchorOf(element);
    if (anchor !== null) {
      break;
    }

    const { localName } = element;
    const siblings =
      element.parentNode === null
        ? [element]
        : Array.from((element.parentNode as ParentNode).children);
    const sameTag = siblings.filter((sibling) => {
      return sibling.localName === localName;
    });
    steps.push(`${localName}:${ordinalAmong(element, sameTag)}`);

    if (steps.length > MAX_STEPS) {
      return null;
    }
  }

  if (anchor === null) {
    return null;
  }

  const path = ['v1:' + anchor, ...steps.reverse()].join('>');
  return path.length > MAX_LENGTH ? null : path;
}
