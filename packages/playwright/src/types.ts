import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { WebRalphConfig } from '@ralphralphai/config';

export type RalphOptions = {
  mode?: 'off' | 'local' | 'upload' | 'deploy';
  config?: WebRalphConfig;
  configPath?: string;
  runId?: string;
  buildId?: string;
  settleMs?: number;
  reduceMotion?: boolean;
  /**
   * Install Playwright's clock before navigation. Before capture, finish finite
   * browser animations and allow JS-driven DOM changes to settle within a
   * bounded wait, then pause timers and remaining animations. Defaults to false.
   * Owns the context's clock; do not combine with manual page.clock control.
   */
  freezeDuringCapture?: boolean;
  recordTimeoutMs?: number;
  /**
   * CSS selectors for subtrees the diff ignores, such as an ad slot or a chat
   * widget. They are left out of the aria snapshot but stay in the screenshot.
   */
  ignoreInDiff?: string[];
  ready?: (page: Page, signal: AbortSignal) => Promise<void>;
  /**
   * Fail the test when the app reports a tag outside the set the test
   * declared for it. Otherwise the mismatch is only listed on the node.
   */
  strictNodeTags?: boolean;
  /**
   * Make `recordNode`, `setNodeConditions`, and `observe` no-ops in tests
   * without the `@ralph` tag, instead of throwing, so helpers shared with
   * untagged tests can call them.
   */
  ignoreUntaggedCalls?: boolean;
};

/** A `number` must be an integer, because values match by their JSON spelling and a float can be spelled more than one way. */
export type TagValue = boolean | number | string;

/** One value, or the set of values the node stands for. `null` and `undefined` in a set mean the key is absent. */
export type TagDeclaration = Record<
  string,
  TagValue | (TagValue | null | undefined)[] | undefined
>;

export type ConditionsDeclaration = {
  visitorTags?: TagDeclaration;
  pageTags?: TagDeclaration;
};

/** Each key's accepted values, `null` accepting the key's absence. */
export type TagConditions = Record<string, (TagValue | null)[]>;

export type NodeConditions = {
  visitorTags?: TagConditions;
  pageTags?: TagConditions;
};

/** The tags the app's tracker had in effect. */
export type RecordedTags = {
  visitorTags: Record<string, TagValue>;
  pageTags: Record<string, TagValue>;
};

export type RecordNodeOptions = {
  /**
   * What the node stands for, such as `Checkout`, shown on the node in the
   * graph. A retake without one keeps the name already given.
   */
  name?: string;
  /**
   * How the test got here from the node before, such as `Add to cart`, shown
   * on the edge into this node beside the actions recorded on it. A retake
   * without one keeps the label already given.
   */
  edgeLabel?: string;
};

export type VisitAllLinksOptions = {
  /**
   * Runs in each opened tab before it closes, e.g. to assert where it landed
   * or to `recordNode` it with a name.
   */
  onVisit?: (page: Page) => Promise<void>;
};

export type Ralph = {
  /**
   * Takes the node's screenshot now, replacing the one taken automatically
   * when the URL or the declared conditions changed, which can catch the page
   * mid-transition. Call it once the page shows what the node stands for.
   */
  recordNode(page: Page, options?: RecordNodeOptions): Promise<void>;
  /**
   * Declares which visitor and page tags the node on screen stands for,
   * merged over earlier declarations until the URL changes, and records the
   * node. It changes no app state. The returned function removes this call's
   * declaration and records again.
   */
  setNodeConditions(
    page: Page,
    conditions: ConditionsDeclaration,
  ): Promise<() => Promise<void>>;
  waitForCapture(): Promise<void>;
  /**
   * Opens each link `links` matches in its own tab, one at a time, records
   * it, and closes it, so every target links from the page the links are on
   * rather than from the target before it. Throws before opening any when a
   * match is not an `<a href>`.
   */
  visitAllLinks(links: Locator, options?: VisitAllLinksOptions): Promise<void>;
  pause(): void;
  resume(): void;
  /** With freezeDuringCapture, await this before any scripts run in a custom context. */
  observe(context: BrowserContext): Promise<void>;
};

export type TrackedElement = {
  trackId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ActionKind =
  | 'click'
  | 'dblclick'
  | 'tap'
  | 'hover'
  | 'check'
  | 'uncheck'
  | 'fill'
  | 'type'
  | 'press'
  | 'selectOption'
  | 'setInputFiles'
  | 'dragTo'
  | 'goto'
  | 'goBack'
  | 'goForward'
  | 'reload';

/** The element an action landed on, as the page showed it at that moment. */
export type ActionTarget = {
  tag: string;
  role?: string;
  /** What a reader would call it: its label, its text, or its alt text. */
  name?: string;
  trackId?: string;
  /** In CSS pixels from the document's top-left, the space of the screenshot of the node the action was taken on. */
  box: { x: number; y: number; width: number; height: number };
};

export type RawAction = {
  kind: ActionKind;
  startedAt: string;
  /** The tab it happened in, known when it reached an element. */
  pageId?: string;
  /** What the test acted on, in Playwright's selector syntax. */
  selector?: string;
  /**
   * The text, key, URL, option, or file names, or for `dragTo`, the
   * selector it was dropped on. Left out for what was typed
   * into a password or one-time-code field, or into a field the page did not
   * report.
   */
  value?: string;
  /** Absent when the page reported no element for it, e.g. `goto`. */
  target?: ActionTarget;
};

export type PageLayout = {
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  scroll: { x: number; y: number };
  devicePixelRatio: number;
  trackedElements: TrackedElement[];
};

export type RawNode = {
  nodeId: string;
  pageId: string;
  sequence: number;
  requestedAt: string;
  actualUrl: string;
  url: string;
  trigger: 'url-change' | 'condition-change' | 'explicit';
  name?: string;
  /** What the node stands for, as the test declared it. */
  conditions?: NodeConditions;
  /** What the app's tracker had in effect, absent when the page runs none. */
  reportedTags?: RecordedTags;
  /** Declared keys the reported value falls outside, as `visitorTags.plan`. */
  tagMismatches?: string[];
  /**
   * The node this page state was reached from: the previous one on the same
   * page, or for a popup's first node, its opener's latest. Superseded and
   * failed nodes are included; the server walks past the ones it doesn't show.
   */
  previousNodeId?: string;
  /** The test's words for how it got here from `previousNodeId`. */
  edgeLabel?: string;
  /**
   * What the test did between requesting `previousNodeId` and this node, in
   * order. Actions taken while recording was paused are left out.
   */
  actions?: RawAction[];
} & (
  | {
      status: 'recorded';
      recordedAt: string;
      layout: PageLayout;
      geometryStable: boolean;
      screenshot: {
        path: string;
        attachmentName: string;
        width: number;
        height: number;
        scale: 'css';
        contentType: 'image/webp' | 'image/png';
      };
      /**
       * The page's aria tree with document-space boxes, which Ralph diffs
       * against the previous deployment. Absent when the capture failed or
       * ran out of time, or the page's tree is too large to send.
       */
      ariaSnapshot?: {
        path: string;
        attachmentName: string;
      };
    }
  | {
      /** The page was visited but has no screenshot. */
      status: 'uncaptured';
      /**
       * `navigated-away`: the tab navigated or closed first, e.g. the test
       * moved on, a redirect, or a route replaced at once. `error`: the
       * recording failed, e.g. it timed out.
       */
      reason: 'navigated-away' | 'error';
      /** The error as thrown. */
      message: string;
    }
);

export type ConfigSnapshot = {
  config: WebRalphConfig;
  packageVersion: string;
};

export type RawGraphProducer = {
  name: '@ralphralphai/playwright';
  version: string;
  playwrightVersion: string;
};

export type RawPage = {
  /** Unique within its test only. */
  pageId: string;
  browserName?: string;
  openerPageId?: string;
};

/** One test's recordings. Its nodes link only to each other. */
export type RawGraph = {
  id: string;
  titlePath: string[];
  project: string;
  retry: number;
  repeatEachIndex: number;
  workerIndex: number;
  parallelIndex: number;
  status: string;
  expectedStatus: string;
  startedAt: string;
  finishedAt: string;
  pages: RawPage[];
  nodes: RawNode[];
  /** The test passed and every node was recorded with stable geometry. */
  complete: boolean;
};

/**
 * What a test writes and attaches as `ralph-raw-graph`, for the reporter to
 * merge into the run's `RawGraphManifest`.
 */
export type RawGraphFile = {
  formatVersion: 1;
  producer: RawGraphProducer;
  runId?: string;
  buildId?: string;
  config: ConfigSnapshot;
  /**
   * The test's mode. The reporter uploads the run if any test's is `upload` or
   * `deploy`, and uploads it as its build's if any is `deploy`.
   */
  mode: 'local' | 'upload' | 'deploy';
  rawGraph: RawGraph;
};

/** One Playwright run (or shard): every recorded test's raw graph, merged. */
export type RawGraphManifest = {
  formatVersion: 1;
  producer: RawGraphProducer;
  runId?: string;
  buildId?: string;
  /** New for every run, so each run is its own artifact. */
  artifactId: string;
  shard: { current: number; total: number } | null;
  startedAt: string;
  finishedAt: string;
  config: ConfigSnapshot;
  /** The final attempt of each recorded test, one raw graph each. */
  rawGraphs: RawGraph[];
  /** Every raw graph is complete. */
  complete: boolean;
};
