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
};

export type RecordNodeOptions = { state?: string; url?: string };

export type Ralph = {
  recordNode(page: Page, options?: RecordNodeOptions): Promise<void>;
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
  trigger: 'url-change' | 'explicit';
  state?: string;
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
