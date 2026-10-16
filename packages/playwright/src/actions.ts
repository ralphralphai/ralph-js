import path from 'node:path';

import type { BrowserContext, Page } from '@playwright/test';

import type { ActionKind, ActionTarget, RawAction } from './types';

const BINDING = '__ralphAction';

const MAX_TEXT = 200;

/** An event reaches Node within a few actions of firing; scanning further only adds wrong matches. */
const RECENT_ACTIONS = 20;

type ActionSpec = {
  kind: ActionKind;
  /** The DOM events that show which element the action landed on, first one wins. */
  events: readonly string[];
  value?: (params: Record<string, unknown>) => string | undefined;
};

const text = (key: string) => {
  return (params: Record<string, unknown>) => {
    return typeof params[key] === 'string' ? params[key] : undefined;
  };
};

/** Keyed by Playwright protocol method, which is what `Locator`, `Page`, `Frame`, `ElementHandle`, `Keyboard` and `Mouse` calls all arrive as. */
const ACTIONS: Record<string, ActionSpec> = {
  click: { kind: 'click', events: ['click'] },
  mouseClick: { kind: 'click', events: ['click'] },
  dblclick: { kind: 'dblclick', events: ['dblclick', 'click'] },
  tap: { kind: 'tap', events: ['touchstart', 'click'] },
  hover: { kind: 'hover', events: ['mouseover'] },
  check: { kind: 'check', events: ['click'] },
  uncheck: { kind: 'uncheck', events: ['click'] },
  fill: { kind: 'fill', events: ['input'], value: text('value') },
  type: { kind: 'type', events: ['input'], value: text('text') },
  keyboardType: { kind: 'type', events: ['input'], value: text('text') },
  keyboardInsertText: { kind: 'type', events: ['input'], value: text('text') },
  press: { kind: 'press', events: ['keydown'], value: text('key') },
  keyboardPress: { kind: 'press', events: ['keydown'], value: text('key') },
  selectOption: {
    kind: 'selectOption',
    events: ['input'],
    value: (params) => {
      const options = params['options'];
      if (!Array.isArray(options)) {
        return undefined;
      }
      return options
        .map((option: Record<string, unknown>) => {
          return String(
            option['valueOrLabel'] ??
              option['label'] ??
              option['value'] ??
              '#' + String(option['index']),
          );
        })
        .join(', ');
    },
  },
  setInputFiles: {
    kind: 'setInputFiles',
    events: ['input'],
    value: (params) => {
      const payloads = params['payloads'];
      const localPaths = params['localPaths'];
      const names = Array.isArray(payloads)
        ? payloads.map((payload: { name?: unknown }) => {
            return String(payload.name);
          })
        : Array.isArray(localPaths)
          ? localPaths.map((file) => {
              return path.basename(String(file));
            })
          : [];
      return names.length > 0 ? names.join(', ') : undefined;
    },
  },
  dragAndDrop: {
    kind: 'dragTo',
    events: ['mousedown', 'dragstart'],
    value: text('target'),
  },
  goto: { kind: 'goto', events: [], value: text('url') },
  goBack: { kind: 'goBack', events: [] },
  goForward: { kind: 'goForward', events: [] },
  reload: { kind: 'reload', events: [] },
};

/**
 * What Playwright may perform by setting the value from script, whose `input`
 * event is untrusted. An untrusted event the app fires itself is not taken
 * for any other action.
 */
const SCRIPTED = new Set<ActionKind>(['fill', 'selectOption', 'setInputFiles']);

const NAVIGATIONS = new Set<ActionKind>([
  'goto',
  'goBack',
  'goForward',
  'reload',
]);

/** Only the page can tell a password field from another, so these values wait
 * for its report. */
const VALUE_NEEDS_TARGET = new Set<ActionKind>(['fill', 'type', 'press']);

type DomEvent = {
  type: string;
  /** `Date.now()` in the page when the event fired. */
  at: number;
  /** How long the field's value was then, for an `input` on a text field. */
  valueLength?: number;
  /** Set on `keydown` for a named key, such as `Enter`. A character is never sent. */
  key?: string;
  trusted: boolean;
  sensitive: boolean;
  target: ActionTarget;
};

type LoggedAction = {
  kind: ActionKind;
  /** Where it falls among node requests, which share the counter. */
  order: number;
  startedAt: string;
  startedAtMs: number;
  endedAtMs?: number;
  awaits: readonly string[];
  selector?: string;
  value?: string;
  pageId?: string;
  target?: ActionTarget;
  sensitive?: boolean;
  valueLength?: number;
};

/** The edge into `nodeId`, which takes the actions ordered after `after` up to
 * `upTo`. */
export type ActionWindow = {
  nodeId: string;
  after: number;
  upTo: number;
  pageIds: ReadonlySet<string>;
};

/** The listener interface of Playwright's client instrumentation, which its own
 * test runner uses to turn API calls into steps. */
type ApiCallListener = {
  onApiCallBegin?: (
    zone: object,
    call: { type: string; method: string; params?: Record<string, unknown> },
  ) => void;
  onApiCallEnd?: (zone: object) => void;
};
type ClientInstrumentation = {
  addListener(listener: ApiCallListener): void;
  removeListener(listener: ApiCallListener): void;
};

/**
 * The actions a test takes between two nodes, each with the element it
 * landed on, for the edge between them. Two sources are needed because
 * neither knows enough alone.
 *
 * 1. What the test asked for. The Playwright client turns every call, such
 *    as `locator.click()`, into a protocol message, such as `Frame.click
 *    { selector }`, that it sends to the Playwright server driving the
 *    browser. Before sending, it calls `onApiCallBegin(zone, { type, method,
 *    params })` on its instrumentation, and `onApiCallEnd(zone)` once the
 *    reply arrives. `@playwright/test` builds its report steps from the same
 *    hook. It gives the exact action and its selector, value, key or URL, but
 *    not the tab it ran in or the element the selector resolved to. It is
 *    not public API, so when a Playwright release changes it, `attach` finds
 *    no listener interface and only the page's reports of clicks, typing and
 *    Enter remain.
 *
 * 2. Where it landed. An init script in every page reports the trusted DOM
 *    events Playwright's input causes: the element's role, name,
 *    `data-track-id` and box in the screenshot's space, whether it is a
 *    password field, and when the event fired. The binding it reports
 *    through tells which tab it came from. A navigation causes no such
 *    event, so its tab is the one that navigates while it runs (see
 *    `navigated`).
 *
 * A report travels from the page through the Playwright server separately
 * from the call's reply, so it can arrive after the next call began. It is
 * therefore matched by the time the event fired against each call's start
 * and end, never by arrival (see `landed`). A typed value survives only once
 * the page has shown that its field is not sensitive.
 *
 * Calls and node requests draw from one counter (`next`), so at the end of
 * the test `assign` can give each action to the edge into the first node
 * requested after it.
 */
export class ActionLog {
  private readonly actions: LoggedAction[] = [];
  private readonly byZone = new WeakMap<object, LoggedAction>();
  private instrumentation?: ClientInstrumentation;
  private readonly listener: ApiCallListener = {
    onApiCallBegin: (zone, call) => {
      this.begin(zone, call);
    },
    onApiCallEnd: (zone) => {
      const action = this.byZone.get(zone);
      if (action) {
        action.endedAtMs = Date.now();
      }
    },
  };

  constructor(
    private readonly next: () => number,
    private readonly recording: () => boolean,
    private readonly pageIdOf: (page: Page) => string | undefined,
    private readonly openPageIds: () => string[],
  ) {}

  attach(playwright: unknown): void {
    const instrumentation = (
      playwright as { _instrumentation?: Partial<ClientInstrumentation> }
    )?._instrumentation;

    if (
      typeof instrumentation?.addListener === 'function' &&
      typeof instrumentation.removeListener === 'function'
    ) {
      this.instrumentation = instrumentation as ClientInstrumentation;
      this.instrumentation.addListener(this.listener);
    }
  }

  detach(): void {
    this.instrumentation?.removeListener(this.listener);
  }

  async observe(context: BrowserContext): Promise<void> {
    // Sent together, so all are queued before the test's next action. The
    // init script only reaches documents created after it, so a page loaded
    // before the context was observed gets the reporter directly.
    await Promise.all([
      context
        .exposeBinding(BINDING, ({ page }, event: unknown) => {
          if (isDomEvent(event)) {
            this.landed(page, event);
          }
        })
        .catch(() => {
          // A context the test reuses across tests already has the binding,
          // and reports to the recorder of the test that installed it.
          // Actions then have no element, which only costs their boxes.
        }),
      context.addInitScript(installActionReporter, BINDING).catch(() => {}),
      ...context.pages().map((page) => {
        return page.evaluate(installActionReporter, BINDING).catch(() => {});
      }),
    ]);
  }

  /**
   * A navigation reaches no element for the page to report, so the tab whose
   * main frame navigates while the call runs is the tab it ran in.
   */
  navigated(page: Page): void {
    const pageId = this.pageIdOf(page);
    const running = this.actions
      .slice(-RECENT_ACTIONS)
      .reverse()
      .find((action) => {
        return (
          NAVIGATIONS.has(action.kind) &&
          action.pageId === undefined &&
          action.endedAtMs === undefined
        );
      });

    if (running && pageId !== undefined) {
      running.pageId = pageId;
    }
  }

  /**
   * Each window's actions. An action goes to the earliest window
   * that holds it, so the click that opened a popup is on the edge into the
   * popup and not also on the next edge of its own tab. An action whose tab
   * is still unknown goes to none: it could have run in any tab open then.
   */
  assign(windows: ActionWindow[], limit: number): Map<string, RawAction[]> {
    const taken = new Set<LoggedAction>();
    const assigned = new Map<string, RawAction[]>();
    const byEnd = [...windows].sort((a, b) => a.upTo - b.upTo);
    for (const { nodeId, after, upTo, pageIds } of byEnd) {
      const actions = this.actions.filter((action) => {
        return (
          !taken.has(action) &&
          action.order > after &&
          action.order <= upTo &&
          action.pageId !== undefined &&
          pageIds.has(action.pageId)
        );
      });
      for (const action of actions) {
        taken.add(action);
      }

      if (actions.length > 0) {
        assigned.set(nodeId, actions.slice(-limit).map(toRawAction));
      }
    }
    return assigned;
  }

  private begin(
    zone: object,
    call: { type: string; method: string; params?: Record<string, unknown> },
  ): void {
    const spec = ACTIONS[call.method];
    if (
      !spec ||
      !['Frame', 'Page', 'ElementHandle'].includes(call.type) ||
      !this.recording()
    ) {
      return;
    }

    const params = call.params ?? {};
    const selector =
      typeof params['selector'] === 'string'
        ? params['selector']
        : typeof params['source'] === 'string'
          ? params['source']
          : undefined;

    // The call does not say which tab it is on. With one tab open, that is
    // the one; otherwise the page's report or the navigation it causes says.
    const open = this.openPageIds();
    const action: LoggedAction = {
      kind: spec.kind,
      order: this.next(),
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      awaits: spec.events,
      selector,
      value: clip(spec.value?.(params)),
      pageId: open.length === 1 ? open[0] : undefined,
    };
    this.byZone.set(zone, action);
    this.actions.push(action);
  }

  /**
   * The event goes to the action that was running when it fired. Its report
   * can reach here after the next action started, so arrival order says
   * nothing. When one action ends in the millisecond the next starts, the
   * earlier one takes it, since an event fires before its action returns.
   */
  private landed(page: Page, event: DomEvent): void {
    const pageId = this.pageIdOf(page);
    const action = this.actions.slice(-RECENT_ACTIONS).find((candidate) => {
      return (
        candidate.target === undefined &&
        candidate.awaits.includes(event.type) &&
        (event.trusted || SCRIPTED.has(candidate.kind)) &&
        candidate.startedAtMs <= event.at &&
        event.at <= (candidate.endedAtMs ?? Infinity)
      );
    });

    if (action) {
      action.target = event.target;
      action.sensitive = event.sensitive;
      if (event.valueLength !== undefined) {
        action.valueLength = event.valueLength;
      }

      if (pageId !== undefined) {
        action.pageId = pageId;
      }
      return;
    }

    if (!this.instrumentation && event.trusted && this.recording()) {
      this.logFromPage(event, pageId);
    }
  }

  private logFromPage(event: DomEvent, pageId: string | undefined): void {
    const kind: ActionKind | undefined =
      event.type === 'click'
        ? 'click'
        : event.type === 'input'
          ? 'fill'
          : event.type === 'keydown' && event.key === 'Enter'
            ? 'press'
            : undefined;
    if (kind === undefined) {
      return;
    }

    const previous = this.actions.at(-1);
    const sameField =
      kind === 'fill' &&
      previous?.kind === 'fill' &&
      JSON.stringify(previous.target) === JSON.stringify(event.target);
    if (sameField) {
      return;
    }

    this.actions.push({
      kind,
      order: this.next(),
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      awaits: [],
      target: event.target,
      sensitive: event.sensitive,
      value: kind === 'press' ? event.key : undefined,
      pageId,
    });
  }
}

function toRawAction(action: LoggedAction): RawAction {
  return {
    kind: action.kind,
    startedAt: action.startedAt,
    pageId: action.pageId,
    selector: action.selector,
    value: revealedValue(action),
    target: action.target,
  };
}

function revealedValue(action: LoggedAction): string | undefined {
  if (!VALUE_NEEDS_TARGET.has(action.kind)) {
    return action.value;
  }

  const namedKey = action.kind === 'press' && (action.value?.length ?? 0) > 1;
  if (namedKey) {
    return action.value;
  }

  if (action.target === undefined || action.sensitive !== false) {
    return undefined;
  }

  // The field's length checks that the event really was this action's: a
  // browser whose clock is off from this one could hand one field's event to
  // the action on another, and show a password under the wrong field.
  const length = action.value?.length ?? 0;
  const fits =
    action.kind === 'fill'
      ? action.valueLength === length
      : action.kind === 'type'
        ? (action.valueLength ?? -1) >= length
        : true;
  return fits ? action.value : undefined;
}

function clip(value: string | undefined): string | undefined {
  return value === undefined || value.length <= MAX_TEXT
    ? value
    : value.slice(0, MAX_TEXT - 1) + '…';
}

function isDomEvent(event: unknown): event is DomEvent {
  const candidate = event as Partial<DomEvent> | null;
  const box = candidate?.target?.box;
  return (
    typeof candidate?.type === 'string' &&
    typeof candidate.at === 'number' &&
    typeof candidate.trusted === 'boolean' &&
    typeof candidate.sensitive === 'boolean' &&
    typeof candidate.target?.tag === 'string' &&
    typeof box?.x === 'number' &&
    typeof box.y === 'number' &&
    typeof box.width === 'number' &&
    typeof box.height === 'number'
  );
}

/**
 * Runs in every page. Serialized by Playwright, so it may use nothing from
 * its module.
 */
function installActionReporter(binding: string): void {
  // An iframe's boxes would be relative to the iframe, not the screenshot.
  if (window !== window.top) {
    return;
  }

  // A document loaded while its context was being observed gets the reporter
  // both from the init script and directly, and must report each event once.
  const installed = binding + 'Installed';
  if (installed in window) {
    return;
  }
  Object.defineProperty(window, installed, { value: true });

  const maxText = 200;
  const clean = (value: string | null | undefined) => {
    const collapsed = value?.replace(/\s+/g, ' ').trim();
    return collapsed ? collapsed.slice(0, maxText) : undefined;
  };
  const inputRoles: Record<string, string> = {
    checkbox: 'checkbox',
    radio: 'radio',
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
  };
  const roleOf = (element: Element): string | undefined => {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit) {
      return explicit;
    }

    const tag = element.tagName.toLowerCase();
    if (tag === 'a') {
      return element.hasAttribute('href') ? 'link' : undefined;
    }

    if (tag === 'button' || tag === 'summary') {
      return 'button';
    }

    if (tag === 'select') {
      const select = element as HTMLSelectElement;
      return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
    }

    if (tag === 'textarea') {
      return 'textbox';
    }

    if (tag === 'option') {
      return 'option';
    }

    if (tag === 'img') {
      return 'img';
    }

    if (/^h[1-6]$/.test(tag)) {
      return 'heading';
    }

    if (tag === 'input') {
      const input = element as HTMLInputElement;
      return (
        inputRoles[input.type] ??
        (input.hasAttribute('list') ? 'combobox' : 'textbox')
      );
    }
    return undefined;
  };
  // An approximation of the accessible name. A text field's value is never
  // part of it, since that is what was typed.
  const nameOf = (element: Element): string | undefined => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelled = clean(
        labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
      if (labelled) {
        return labelled;
      }
    }

    const ariaLabel = clean(element.getAttribute('aria-label'));
    if (ariaLabel) {
      return ariaLabel;
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      const labels = clean(
        [...(element.labels ?? [])]
          .map((label) => label.textContent ?? '')
          .join(' '),
      );
      if (labels) {
        return labels;
      }

      if (
        element instanceof HTMLInputElement &&
        ['submit', 'button', 'reset'].includes(element.type)
      ) {
        return clean(element.value);
      }
      return (
        clean(element.getAttribute('placeholder')) ??
        clean(element.getAttribute('title'))
      );
    }

    if (element instanceof HTMLImageElement) {
      return clean(element.alt) ?? clean(element.title);
    }
    return (
      clean((element as HTMLElement).innerText ?? element.textContent) ??
      clean(element.getAttribute('title'))
    );
  };
  const interactive =
    'a[href],button,input,select,textarea,summary,label,option,[role],[data-track-id],[contenteditable=""],[contenteditable="true"],[tabindex]';

  let lastHovered: Element | undefined;
  const report = (event: Event) => {
    // Playwright sets a select's or a date field's value from script, which
    // fires untrusted events, so whether to believe one is decided in Node.
    if (!event.isTrusted && event.type !== 'input') {
      return;
    }

    const origin = event.composedPath()[0];
    const element =
      origin instanceof Element
        ? origin
        : origin instanceof Node
          ? origin.parentElement
          : null;
    if (!element) {
      return;
    }

    const actual = element.closest(interactive) ?? element;
    if (event.type === 'mouseover') {
      if (actual === lastHovered) {
        return;
      }
      lastHovered = actual;
    }

    const key = (event as KeyboardEvent).key;
    const rect = actual.getBoundingClientRect();
    const trackId = actual
      .closest('[data-track-id]')
      ?.getAttribute('data-track-id');
    const role = roleOf(actual);
    const name = nameOf(actual);
    const sensitive =
      actual instanceof HTMLInputElement &&
      (actual.type === 'password' ||
        /password|one-time-code|cc-/.test(actual.autocomplete));
    const valueLength =
      event.type === 'input' &&
      (actual instanceof HTMLInputElement ||
        actual instanceof HTMLTextAreaElement)
        ? actual.value.length
        : undefined;
    const send = (window as unknown as Record<string, unknown>)[binding];
    if (typeof send !== 'function') {
      return;
    }

    void (send as (payload: unknown) => Promise<void>)({
      type: event.type,
      trusted: event.isTrusted,
      at: Date.now(),
      ...(valueLength === undefined ? {} : { valueLength }),
      ...(event.type === 'keydown' && key && key.length > 1 ? { key } : {}),
      sensitive,
      target: {
        tag: actual.tagName.toLowerCase(),
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        ...(trackId ? { trackId } : {}),
        box: {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        },
      },
    }).catch(() => undefined);
  };
  for (const type of [
    'click',
    'dblclick',
    'touchstart',
    'mouseover',
    'mousedown',
    'dragstart',
    'input',
    'keydown',
  ]) {
    window.addEventListener(type, report, { capture: true, passive: true });
  }
}
