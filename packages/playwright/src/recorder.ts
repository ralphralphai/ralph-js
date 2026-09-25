import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type { BrowserContext, Frame, Page, TestInfo } from '@playwright/test';
import playwrightPackage from '@playwright/test/package.json' with { type: 'json' };

import packageInfo from '../package.json';
import { waitForAnimations } from './animations';
import { imageExtension, takeScreenshot, type Screenshot } from './image';
import { readLayout } from './layout';
import type {
  RawNode,
  RawPage,
  RawGraphFile,
  RecordNodeOptions,
  ConfigSnapshot,
  Ralph,
  RalphOptions,
} from './types';

/** The attachment holding a test's `RawGraphFile`, which the reporter merges. */
export const MANIFEST_ATTACHMENT = 'ralph-raw-graph';

/**
 * Set by the reporter in the main process before any worker starts, so the
 * fixtures can refuse to upload without it.
 */
export const REPORTER_ENV = 'RALPH_PLAYWRIGHT_REPORTER';

/** Prefix of the attachment holding each recorded node's screenshot; the node id follows. */
export const SCREENSHOT_ATTACHMENT_PREFIX = 'ralph-screenshot-';

const DEFAULT_SETTLE_MS = 150;
const DEFAULT_RECORD_TIMEOUT_MS = 5_000;

/** Where the raw graph and screenshots are written, inside Playwright's per-test output directory. */
const OUTPUT_DIR = 'ralph';

type PageInfo = RawPage;

type CreateNodeRequest = Omit<RawNode, 'status'>;

type RecordedNode = Extract<RawNode, { status: 'recorded' }>;

/** What the recorder tracks for one browser tab. */
type PageState = {
  page: Page;
  info: PageInfo;

  /** The URL of the last navigation, so a reload is not recorded again. */
  lastUrl: string;

  /**
   * Bumped on every main-frame navigation, including reloads. A recording that
   * sees a different generation when it finishes was overtaken by one.
   */
  generation: number;

  /** The next node's position within this tab. */
  sequence: number;

  /** The last queued recording. Recordings in a tab run one at a time. */
  tail: Promise<void>;

  /** Resolves once `info.openerPageId` is known. */
  opener: Promise<void>;

  /**
   * For a tab first used while recording was paused: the last node requested
   * before the pause. Its first node links here when neither the tab nor its
   * opener has an earlier one. Popups inherit it from their opener.
   */
  pauseAnchor?: string;

  onNavigation: (frame: Frame) => void;
};

export class Recorder implements Ralph {
  private readonly startedAt = new Date().toISOString();

  /** How long to wait after a navigation's DOM loads before recording. */
  private readonly settleMs: number;

  /**
   * The budget for recording one node, from settling through the screenshot.
   * Past it, the node is recorded as failed.
   */
  private readonly recordTimeoutMs: number;

  /**
   * Every context being watched, with its page listener, kept so
   * `stopContext` can remove the exact listener `observe` added.
   */
  private readonly contexts = new Map<BrowserContext, (page: Page) => void>();

  /**
   * Every tab seen in a watched context, including closed ones, so their
   * nodes and opener links still reach the manifest.
   */
  private readonly pages = new Map<Page, PageState>();

  /**
   * Each node's outcome, in completion order. Nodes in one tab complete
   * in sequence, but tabs interleave; `finish` sorts them.
   */
  private readonly nodes: RawNode[] = [];

  /**
   * When each node was requested, keyed by node id, for linking a
   * popup's first node to its opener's latest. Numbers, so they compare
   * without parsing each node's `requestedAt` string.
   */
  private readonly requestedAtMs = new Map<string, number>();

  /** Set by `finish`, after which `observe` throws. */
  private closed = false;

  /** Set by `pause`; while set, no new nodes are requested. */
  private paused = false;

  /** The most recently requested node, the anchor for tabs used while paused. */
  private lastRequestedNodeId?: string;

  constructor(
    private readonly options: RalphOptions,
    private readonly config: ConfigSnapshot,
    private readonly testInfo: TestInfo,
    private readonly mode: RawGraphFile['mode'],
  ) {
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.recordTimeoutMs = options.recordTimeoutMs ?? DEFAULT_RECORD_TIMEOUT_MS;

    const validTimings =
      Number.isFinite(this.settleMs) &&
      this.settleMs >= 0 &&
      Number.isFinite(this.recordTimeoutMs) &&
      this.recordTimeoutMs > this.settleMs;
    if (!validTimings) {
      throw new Error(
        'Ralph recordTimeoutMs must be finite and greater than settleMs, which must be non-negative.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Starts recording URL changes in every current and future tab of `context`. */
  observe(context: BrowserContext): void {
    if (this.closed) {
      throw new Error('The Ralph recorder has finished.');
    }
    if (this.contexts.has(context)) {
      return;
    }

    const onPage = (page: Page) => this.watchPage(page);
    this.contexts.set(context, onPage);

    context.on('page', onPage);
    for (const page of context.pages()) {
      onPage(page);
    }
  }

  /** Records the page as it is now, e.g. an open dialog at the same URL. */
  async recordNode(page: Page, options: RecordNodeOptions = {}): Promise<void> {
    this.observe(page.context());
    const state = this.pages.get(page);
    if (!state) {
      throw new Error('Cannot record a closed browser page.');
    }

    if (this.paused) {
      return;
    }

    await this.enqueueCreateNodeRequest(state, 'explicit', options);
  }

  /**
   * Stops requesting nodes, automatic or explicit, until `resume`. Recordings
   * already requested still complete. The next node after `resume` links to
   * the last one before `pause`, so the skipped steps drop out of the graph.
   */
  pause(): void {
    this.paused = true;
  }

  /** Undoes `pause`. The current page is not recorded until its URL changes. */
  resume(): void {
    this.paused = false;
  }

  /** Waits until every page recording requested so far has finished. */
  async waitForCapture(): Promise<void> {
    await Promise.all([...this.pages.values()].map((state) => state.tail));
  }

  /** Stops watching `context` and waits for its queued recordings. */
  async stopContext(context: BrowserContext): Promise<void> {
    const onPage = this.contexts.get(context);
    if (onPage) {
      context.off('page', onPage);
    }

    const states = [...this.pages.values()].filter(
      (state) => state.page.context() === context,
    );
    for (const state of states) {
      state.page.off('framenavigated', state.onNavigation);
    }
    await Promise.all(states.map((state) => state.tail));
  }

  /**
   * Stops recording, then writes the test's raw graph for the reporter, and
   * fails a passing test whose nodes failed to record.
   */
  async finish(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.contexts.keys()].map((context) => this.stopContext(context)),
    );
    await Promise.all([...this.pages.values()].map((state) => state.opener));

    const nodes = this.nodes.sort(
      (a, b) => a.pageId.localeCompare(b.pageId) || a.sequence - b.sequence,
    );
    linkPreviousNodes(
      nodes,
      (pageId) => this.pageInfo(pageId)?.openerPageId,
      (nodeId) => this.requestedAtMs.get(nodeId) ?? 0,
      (pageId) => this.pageState(pageId)?.pauseAnchor,
    );

    const failures = nodes.filter(
      (item) => item.status === 'uncaptured' && item.reason === 'error',
    );
    await this.writeRawGraph(this.buildRawGraph(nodes, failures.length));

    if (failures.length && this.testInfo.status === 'passed') {
      throw new Error(
        'Ralph could not record ' +
          failures.length +
          ' page state(s). See the ralph-raw-graph attachment.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Watching tabs
  // ---------------------------------------------------------------------------

  private watchPage(page: Page): void {
    if (this.pages.has(page)) {
      return;
    }

    const state: PageState = {
      page,
      info: {
        pageId: 'page-' + this.pages.size,
        browserName: page.context().browser()?.browserType().name(),
      },
      lastUrl: '',
      generation: 0,
      sequence: 0,
      tail: Promise.resolve(),
      opener: Promise.resolve(),
      onNavigation: (frame) => {
        if (frame === page.mainFrame()) {
          this.urlChanged(state);
        }
      },
    };
    this.pages.set(page, state);

    state.opener = page
      .opener()
      .then((opener) => {
        if (opener) {
          const openerState = this.pages.get(opener);
          state.info.openerPageId = openerState?.info.pageId;
          state.pauseAnchor ??= openerState?.pauseAnchor;
        }
      })
      .catch(() => undefined);

    page.on('framenavigated', state.onNavigation);
    this.urlChanged(state);
  }

  private urlChanged(state: PageState): void {
    if (this.paused && state.sequence === 0) {
      state.pauseAnchor ??= this.lastRequestedNodeId;
    }

    // A same-URL navigation is not leaving the page.
    const url = state.page.url();
    if (url === state.lastUrl) {
      return;
    }

    state.generation++;
    state.lastUrl = url;

    if (!this.paused && isHttpUrl(url)) {
      // Automatic recordings never fail the test; failures land in the manifest.
      void this.enqueueCreateNodeRequest(state, 'url-change', {}).catch(
        () => undefined,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  /** Queues a recording behind the tab's earlier ones. */
  private enqueueCreateNodeRequest(
    state: PageState,
    trigger: RawNode['trigger'],
    options: RecordNodeOptions,
  ): Promise<void> {
    const actualUrl = state.page.url();
    const url =
      options.url === undefined
        ? actualUrl
        : new URL(options.url, actualUrl).href;
    if (!isHttpUrl(actualUrl) || !isHttpUrl(url)) {
      throw new Error(
        'Ralph recordings require HTTP or HTTPS page and recorded URLs.',
      );
    }

    const request: CreateNodeRequest = {
      nodeId: randomUUID(),
      pageId: state.info.pageId,
      sequence: state.sequence++,
      requestedAt: new Date().toISOString(),
      actualUrl,
      url,
      trigger,
      ...(options.state === undefined ? {} : { state: options.state }),
    };
    this.requestedAtMs.set(request.nodeId, Date.now());
    this.lastRequestedNodeId = request.nodeId;

    const generation = state.generation;
    const task = state.tail.then(() =>
      this.createNode(state, generation, request),
    );
    state.tail = task.catch(() => undefined);

    return task;
  }

  /**
   * Creates the requested node: `recorded`, or `uncaptured` if the tab
   * navigates or closes first, or the record timeout passes.
   */
  private async createNode(
    state: PageState,
    generation: number,
    request: CreateNodeRequest,
  ): Promise<void> {
    const { page } = state;
    const deadline = startDeadline(
      this.recordTimeoutMs,
      'Ralph recording timed out.',
    );
    const { wait } = deadline;
    const navigatedAway = () =>
      state.generation !== generation || page.url() !== request.actualUrl;

    const check = () => {
      deadline.signal.throwIfAborted();
      if (navigatedAway()) {
        throw new Error('The page navigated before its recording completed.');
      }
      if (page.isClosed()) {
        throw new Error('The page closed before its recording completed.');
      }
    };

    try {
      check();
      if (request.trigger === 'url-change') {
        await this.waitForPageToSettle(page, deadline, check);
      }

      if (this.options.reduceMotion) {
        check();
        // Half the remaining budget, so the screenshot still has time.
        await wait(waitForAnimations(page, (deadline.endsAt - Date.now()) / 2));
      }

      // Geometry is read on both sides of the screenshot to detect layout drift.
      check();
      const before = await wait(readLayout(page));
      check();
      const image = await wait(takeScreenshot(page, deadline.endsAt));
      check();
      const after = await wait(readLayout(page));
      check();

      this.nodes.push({
        ...request,
        status: 'recorded',
        recordedAt: new Date().toISOString(),
        layout: before,
        geometryStable: JSON.stringify(before) === JSON.stringify(after),
        screenshot: await this.saveScreenshot(request.nodeId, image),
      });
    } catch (error) {
      this.nodes.push({
        ...request,
        status: 'uncaptured',
        reason: navigatedAway() ? 'navigated-away' : 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      if (request.trigger === 'explicit') {
        throw error;
      }
    } finally {
      deadline.cancel();
    }
  }

  /** After a navigation: the DOM, the settle delay, then the `ready` hook. */
  private async waitForPageToSettle(
    page: Page,
    { wait, signal }: Deadline,
    check: () => void,
  ): Promise<void> {
    await wait(
      page.waitForLoadState('domcontentloaded', {
        timeout: this.recordTimeoutMs,
      }),
    );
    await wait(delay(this.settleMs, undefined, { signal }));
    check();
    if (this.options.ready) {
      await wait(this.options.ready(page, signal));
    }
  }

  /** Writes the image to the test output and attaches it to the report. */
  private async saveScreenshot(
    nodeId: string,
    image: Screenshot,
  ): Promise<RecordedNode['screenshot']> {
    const path = OUTPUT_DIR + '/' + nodeId + imageExtension(image.contentType);
    const attachmentName = SCREENSHOT_ATTACHMENT_PREFIX + nodeId;

    await mkdir(this.testInfo.outputPath(OUTPUT_DIR), { recursive: true });
    await writeFile(this.testInfo.outputPath(path), image.bytes);
    await this.testInfo.attach(attachmentName, {
      path: this.testInfo.outputPath(path),
      contentType: image.contentType,
    });

    return {
      path,
      attachmentName,
      width: image.width,
      height: image.height,
      scale: 'css',
      contentType: image.contentType,
    };
  }

  // ---------------------------------------------------------------------------
  // Manifest
  // ---------------------------------------------------------------------------

  private pageState(pageId: string): PageState | undefined {
    return [...this.pages.values()].find(
      (state) => state.info.pageId === pageId,
    );
  }

  private pageInfo(pageId: string): PageInfo | undefined {
    return this.pageState(pageId)?.info;
  }

  private buildRawGraph(nodes: RawNode[], failureCount: number): RawGraphFile {
    const { testInfo } = this;
    const testPassed = testInfo.status === 'passed';

    return {
      formatVersion: 1,
      producer: {
        name: '@ralphralphai/playwright',
        version: packageInfo.version,
        playwrightVersion: playwrightPackage.version,
      },
      runId: this.options.runId ?? process.env['RALPH_RUN_ID'],
      buildId: this.options.buildId ?? process.env['RALPH_BUILD_ID'],
      config: this.config,
      mode: this.mode,
      rawGraph: {
        id: testInfo.testId,
        titlePath: testInfo.titlePath,
        project: testInfo.project.name,
        retry: testInfo.retry,
        repeatEachIndex: testInfo.repeatEachIndex,
        workerIndex: testInfo.workerIndex,
        parallelIndex: testInfo.parallelIndex,
        // Failed nodes fail the test in `finish`, after this is written. The
        // reporter replaces it with the final status anyway.
        status:
          failureCount && testPassed
            ? 'failed'
            : (testInfo.status ?? 'unknown'),
        expectedStatus: testInfo.expectedStatus,
        startedAt: this.startedAt,
        finishedAt: new Date().toISOString(),
        pages: [...this.pages.values()].map((state) => state.info),
        nodes,
        complete:
          testPassed &&
          nodes.length > 0 &&
          nodes.every(
            (item) => item.status === 'recorded' && item.geometryStable,
          ),
      },
    };
  }

  private async writeRawGraph(file: RawGraphFile): Promise<void> {
    const path = this.testInfo.outputPath(OUTPUT_DIR, 'raw_graph.json');
    await mkdir(this.testInfo.outputPath(OUTPUT_DIR), { recursive: true });
    await writeFile(path, JSON.stringify(file, null, 2) + '\n');
    await this.testInfo.attach(MANIFEST_ATTACHMENT, {
      path,
      contentType: 'application/json',
    });
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isHttpUrl(url: string): boolean {
  return /^https?:/.test(url);
}

type Deadline = {
  signal: AbortSignal;
  /** Epoch milliseconds at which the deadline passes. */
  endsAt: number;
  /** Rejects with the timeout error if `promise` outlives the deadline. */
  wait: <T>(promise: Promise<T>) => Promise<T>;
  cancel: () => void;
};

function startDeadline(timeoutMs: number, message: string): Deadline {
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(
    () => controller.abort(new Error(message)),
    timeoutMs,
  );
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
  // Nothing may be waiting when the deadline passes.
  aborted.catch(() => undefined);

  return {
    signal,
    endsAt: Date.now() + timeoutMs,
    wait: (promise) => Promise.race([promise, aborted]),
    cancel: () => clearTimeout(timer),
  };
}

/**
 * Sets `previousNodeId` on each node: the one before it in the same
 * tab, or for a popup's first node, its opener's latest. Failing both, a tab
 * first used while paused links to the last node before the pause.
 * Uncaptured nodes stay in the chain, as regular nodes in the server's graph.
 *
 * `nodes` must be sorted by page, then sequence.
 */
function linkPreviousNodes(
  nodes: RawNode[],
  openerOf: (pageId: string) => string | undefined,
  requestedAtMs: (nodeId: string) => number,
  pauseAnchorOf: (pageId: string) => string | undefined,
): void {
  const byPage = new Map<string, RawNode[]>();
  const byId = new Map<string, RawNode>();
  for (const item of nodes) {
    byPage.set(item.pageId, [...(byPage.get(item.pageId) ?? []), item]);
    byId.set(item.nodeId, item);
  }

  const openerNodeBefore = (item: RawNode) => {
    const openerPageId = openerOf(item.pageId);
    const requestedAt = requestedAtMs(item.nodeId);
    return byPage
      .get(openerPageId ?? '')
      ?.filter((candidate) => requestedAtMs(candidate.nodeId) <= requestedAt)
      .at(-1);
  };

  for (const items of byPage.values()) {
    items.forEach((item, index) => {
      const from =
        index > 0
          ? items[index - 1]
          : (openerNodeBefore(item) ??
            byId.get(pauseAnchorOf(item.pageId) ?? ''));
      if (from) {
        item.previousNodeId = from.nodeId;
      }
    });
  }
}
