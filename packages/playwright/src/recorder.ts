import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type { BrowserContext, Frame, Page, TestInfo } from '@playwright/test';
import playwrightPackage from '@playwright/test/package.json' with { type: 'json' };

import packageInfo from '../package.json';
import { imageExtension, takeScreenshot, type Screenshot } from './image';
import { readLayout } from './layout';
import type {
  RawGraphManifest,
  RawNode,
  RecordNodeOptions,
  ConfigSnapshot,
  Ralph,
  RalphOptions,
} from './types';
import { uploadRawGraph, type UploadOptions } from './upload';

export const MANIFEST_ATTACHMENT = 'ralph-raw-graph';

const DEFAULT_SETTLE_MS = 150;
const DEFAULT_RECORD_TIMEOUT_MS = 5_000;

/** Where the raw graph and screenshots are written, inside Playwright's per-test output directory. */
const OUTPUT_DIR = 'ralph';

type PageInfo = RawGraphManifest['pages'][number];

type NodeRequest = Omit<RawNode, 'status'>;

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

  onNavigation: (frame: Frame) => void;
};

export class Recorder implements Ralph {
  /**
   * Identifies this run of the test. A retry gets a new recorder, and so a new
   * id, which is what lets the server tell retries apart and dedupe re-uploads.
   */
  private readonly attemptId = randomUUID();
  private readonly startedAt = new Date().toISOString();

  /** How long to wait after a navigation's DOM loads before recording. */
  private readonly settleMs: number;

  /**
   * The budget for recording one node, from settling through the screenshot.
   * Past it, the node is recorded as failed.
   */
  private readonly recordTimeoutMs: number;

  /**
   * Every context being watched. `onPage` is kept so `stopContext` can remove
   * the exact listener `observe` added. The id is stored in the manifest's
   * `pages[].contextId`.
   */
  private readonly contexts = new Map<
    BrowserContext,
    { id: string; onPage: (page: Page) => void }
  >();

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

  constructor(
    private readonly options: RalphOptions,
    private readonly config: ConfigSnapshot,
    private readonly testInfo: TestInfo,
    private readonly upload?: UploadOptions,
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

    const id = 'context-' + this.contexts.size;
    const onPage = (page: Page) => this.watchPage(page, id);
    this.contexts.set(context, { id, onPage });

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
    await this.enqueue(state, 'explicit', options);
  }

  /** Waits for every queued recording to finish. */
  async flush(): Promise<void> {
    await Promise.all([...this.pages.values()].map((state) => state.tail));
  }

  /** Stops watching `context` and waits for its queued recordings. */
  async stopContext(context: BrowserContext): Promise<void> {
    const entry = this.contexts.get(context);
    if (entry) {
      context.off('page', entry.onPage);
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
   * Stops recording, then writes the manifest, uploads it if configured, and
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
    );

    const failures = nodes.filter((item) => item.status === 'failed');
    const manifest = this.buildManifest(nodes, failures.length);
    await this.writeManifest(manifest);
    if (this.upload) {
      await this.uploadManifest(manifest, this.upload);
    }

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

  private watchPage(page: Page, contextId: string): void {
    if (this.pages.has(page)) {
      return;
    }

    const state: PageState = {
      page,
      info: {
        pageId: 'page-' + this.pages.size,
        contextId,
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
          state.info.openerPageId = this.pages.get(opener)?.info.pageId;
        }
      })
      .catch(() => undefined);

    page.on('framenavigated', state.onNavigation);
    this.urlChanged(state);
  }

  private urlChanged(state: PageState): void {
    state.generation++;

    const url = state.page.url();
    if (url === state.lastUrl) {
      return;
    }
    state.lastUrl = url;

    if (isHttpUrl(url)) {
      // Automatic recordings never fail the test; failures land in the manifest.
      void this.enqueue(state, 'url-change', {}).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  /** Queues a recording behind the tab's earlier ones. */
  private enqueue(
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

    const request: NodeRequest = {
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

    const generation = state.generation;
    const task = state.tail.then(() => this.record(state, generation, request));
    state.tail = task.catch(() => undefined);

    return task;
  }

  /**
   * Records one node and its outcome. Fails if the tab navigates or
   * closes before it finishes, or if it runs past the record timeout.
   */
  private async record(
    state: PageState,
    generation: number,
    request: NodeRequest,
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
        status: navigatedAway() ? 'superseded' : 'failed',
        reason: error instanceof Error ? error.message : String(error),
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
    const attachmentName = 'ralph-screenshot-' + nodeId;

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

  private pageInfo(pageId: string): PageInfo | undefined {
    return [...this.pages.values()].find(
      (state) => state.info.pageId === pageId,
    )?.info;
  }

  private buildManifest(
    nodes: RawNode[],
    failureCount: number,
  ): RawGraphManifest {
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
      attemptId: this.attemptId,
      test: {
        id: testInfo.testId,
        titlePath: testInfo.titlePath,
        project: testInfo.project.name,
        retry: testInfo.retry,
        repeatEachIndex: testInfo.repeatEachIndex,
        workerIndex: testInfo.workerIndex,
        parallelIndex: testInfo.parallelIndex,
        shard: testInfo.config.shard,
        // Failed nodes fail the test in `finish`, after this is written.
        status:
          failureCount && testPassed
            ? 'failed'
            : (testInfo.status ?? 'unknown'),
        expectedStatus: testInfo.expectedStatus,
      },
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      config: this.config,
      pages: [...this.pages.values()].map((state) => state.info),
      nodes,
      complete:
        testPassed &&
        nodes.length > 0 &&
        nodes.every(
          (item) => item.status === 'recorded' && item.geometryStable,
        ),
    };
  }

  private async writeManifest(manifest: RawGraphManifest): Promise<void> {
    const file = this.testInfo.outputPath(OUTPUT_DIR, 'raw_graph.json');
    await mkdir(this.testInfo.outputPath(OUTPUT_DIR), { recursive: true });
    await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
    await this.testInfo.attach(MANIFEST_ATTACHMENT, {
      path: file,
      contentType: 'application/json',
    });
  }

  private async uploadManifest(
    manifest: RawGraphManifest,
    upload: UploadOptions,
  ): Promise<void> {
    const recorded = manifest.nodes.filter(
      (item): item is RecordedNode => item.status === 'recorded',
    );
    const screenshots = [];
    for (const { nodeId, screenshot } of recorded) {
      screenshots.push({
        nodeId,
        contentType: screenshot.contentType,
        bytes: await readFile(this.testInfo.outputPath(screenshot.path)),
      });
    }

    const receipt = await uploadRawGraph(manifest, screenshots, upload);
    await this.testInfo.attach('ralph-upload-receipt', {
      body: JSON.stringify(receipt),
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
 * tab, or for a popup's first node, its opener's latest. Superseded nodes
 * are skipped, since their page state was never shown.
 *
 * `nodes` must be sorted by page, then sequence.
 */
function linkPreviousNodes(
  nodes: RawNode[],
  openerOf: (pageId: string) => string | undefined,
  requestedAtMs: (nodeId: string) => number,
): void {
  const byPage = new Map<string, RawNode[]>();
  for (const item of nodes) {
    byPage.set(item.pageId, [...(byPage.get(item.pageId) ?? []), item]);
  }

  const openerNodeBefore = (item: RawNode) => {
    const openerPageId = openerOf(item.pageId);
    const requestedAt = requestedAtMs(item.nodeId);
    return byPage
      .get(openerPageId ?? '')
      ?.filter((candidate) => requestedAtMs(candidate.nodeId) <= requestedAt)
      .at(-1);
  };

  // First the raw chain, superseded nodes included.
  const previous = new Map<RawNode, RawNode>();
  for (const items of byPage.values()) {
    items.forEach((item, index) => {
      const from = index > 0 ? items[index - 1] : openerNodeBefore(item);
      if (from) {
        previous.set(item, from);
      }
    });
  }

  // Then skip past superseded ones, e.g. a redirect or a replaced route.
  for (const item of nodes) {
    let from = previous.get(item);
    while (from?.status === 'superseded') {
      from = previous.get(from);
    }
    if (from) {
      item.previousNodeId = from.nodeId;
    }
  }
}
