import type { BrowserContext, Page } from '@playwright/test';
import type { WebRalphConfig } from '@ralphralphai/config';

export type RalphOptions = {
  mode?: 'off' | 'local' | 'upload';
  config?: WebRalphConfig;
  configPath?: string;
  runId?: string;
  buildId?: string;
  settleMs?: number;
  reduceMotion?: boolean;
  recordTimeoutMs?: number;
  ready?: (page: Page, signal: AbortSignal) => Promise<void>;
  /**
   * Fail the test when the app reports a tag outside the set the test
   * declared for it. Otherwise the mismatch is only listed on the node.
   */
  strictNodeTags?: boolean;
};

export type RecordNodeOptions = { state?: string; url?: string };

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

export type Ralph = {
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
  pause(): void;
  resume(): void;
  observe(context: BrowserContext): void;
};

export type TrackedElement = {
  trackId: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
  state?: string;
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
  /** The test's mode. The reporter uploads the run if any test's is `upload`. */
  mode: 'local' | 'upload';
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
