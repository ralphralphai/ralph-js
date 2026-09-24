import type { BrowserContext, Page } from '@playwright/test';
import type { WebRalphConfig } from '@ralphralphai/config';

export type RalphOptions = {
  mode?: 'off' | 'local' | 'upload';
  apiUrl?: string;
  appId?: string;
  uploadTimeoutMs?: number;
  config?: WebRalphConfig;
  configPath?: string;
  runId?: string;
  buildId?: string;
  settleMs?: number;
  captureTimeoutMs?: number;
  ready?: (page: Page, signal: AbortSignal) => Promise<void>;
};

export type CaptureOptions = { state?: string; url?: string };

export type Ralph = {
  captureNode(page: Page, options?: CaptureOptions): Promise<void>;
  flush(): Promise<void>;
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
   * The capture this page state was reached from: the previous one on the same
   * page, or for a popup's first capture, its opener's latest. Superseded
   * captures are skipped.
   */
  previousNodeId?: string;
} & (
  | {
      status: 'captured';
      capturedAt: string;
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
  | { status: 'superseded' | 'failed'; reason: string }
);

export type ConfigSnapshot = {
  config: WebRalphConfig;
  packageVersion: string;
};

export type CaptureManifest = {
  formatVersion: 1;
  producer: {
    name: '@ralphralphai/playwright';
    version: string;
    playwrightVersion: string;
  };
  runId?: string;
  buildId?: string;
  attemptId: string;
  test: {
    id: string;
    titlePath: string[];
    project: string;
    retry: number;
    repeatEachIndex: number;
    workerIndex: number;
    parallelIndex: number;
    shard: { current: number; total: number } | null;
    status: string;
    expectedStatus: string;
  };
  startedAt: string;
  finishedAt: string;
  config: ConfigSnapshot;
  pages: {
    pageId: string;
    contextId: string;
    browserName?: string;
    openerPageId?: string;
  }[];
  nodes: RawNode[];
  complete: boolean;
};
