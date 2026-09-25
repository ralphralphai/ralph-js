import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from 'vitest';

import type {
  RawGraphManifest,
  RawNode,
  RawGraph,
  RawGraphFile,
} from '../src/types';
import type { RawGraphBundleIndex } from '../src/upload';
import { readBundle } from './read_bundle';

type ReportTest = {
  title: string;
  results: { attachments: { name: string; path: string }[] }[];
};
type ReportSuite = {
  suites?: ReportSuite[];
  specs?: { title: string; tests: Omit<ReportTest, 'title'>[] }[];
};
const require = createRequire(import.meta.url);
/** Each test's raw graph files, one per attempt. */
const manifests = new Map<string, RawGraphFile[]>();
/** What the reporter merged from the whole run. */
let merged: RawGraphBundleIndex;
let output: string;
let tests: ReportTest[];

beforeAll(async () => {
  output = await mkdtemp(path.join(os.tmpdir(), 'ralph-playwright-'));
  const reportPath = path.join(output, 'report.json');
  const cli = path.join(
    path.dirname(require.resolve('@playwright/test/package.json')),
    'cli.js',
  );
  try {
    await promisify(execFile)(
      process.execPath,
      [cli, 'test', '--config', 'test/playwright.config.ts'],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
          ...process.env,
          RALPH_TEST_OUTPUT: path.join(output, 'artifacts'),
          RALPH_TEST_REPORT: reportPath,
        },
        timeout: 80_000,
      },
    );
  } catch (error) {
    throw new Error(
      'Playwright fixture suite failed: ' +
        String(error) +
        '\n' +
        (error as { stdout?: string }).stdout,
    );
  }
  const report = JSON.parse(
    await readFile(reportPath, 'utf8'),
  ) as ReportSuite & { stats: { unexpected: number } };
  expect(report.stats.unexpected).toBe(0);
  const flatten = (suite: ReportSuite): ReportTest[] => [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests.map((test) => ({ title: spec.title, ...test })),
    ),
    ...(suite.suites ?? []).flatMap(flatten),
  ];
  tests = flatten(report);
  for (const test of tests) {
    const records = [];
    for (const result of test.results) {
      const artifact = result.attachments.find(
        (item) => item.name === 'ralph-raw-graph',
      );
      if (artifact) {
        records.push(
          JSON.parse(await readFile(artifact.path, 'utf8')) as RawGraphFile,
        );
      }
    }
    manifests.set(test.title, records);
  }
  merged = JSON.parse(
    await readFile(
      path.join(output, 'artifacts', 'ralph', 'raw_graph.json'),
      'utf8',
    ),
  ) as RawGraphBundleIndex;
});

afterAll(async () => {
  if (output) {
    await rm(output, { recursive: true, force: true });
  }
});

function manifest(title: string): RawGraph {
  const item = manifests.get(title)?.[0];
  expect(item).toBeDefined();
  return item!.rawGraph;
}
function recordedNodes(title: string) {
  return manifest(title).nodes.filter(
    (item): item is Extract<RawNode, { status: 'recorded' }> =>
      item.status === 'recorded',
  );
}

it('records full-document and SPA URL changes but not reloads or DOM mutations', () => {
  const items = recordedNodes('URL transitions and geometry');
  expect(items.map((item) => item.url)).toEqual([
    'https://fixture.test/home',
    'https://fixture.test/second',
    'https://fixture.test/second?step=1#details',
  ]);
  expect(items.every((item) => item.trigger === 'url-change')).toBe(true);
  expect(items[0].layout.trackedElements).toEqual([
    { trackId: 'checkout', x: 20, y: 40, width: 120, height: 32 },
    { trackId: 'below', x: 30, y: 1000, width: 100, height: 20 },
  ]);
  expect(items[0].screenshot).toMatchObject({
    width: 500,
    height: 1400,
    scale: 'css',
  });
  expect(items[0].layout.devicePixelRatio).toBe(2);
});

it('links each node to the one it was reached from', () => {
  const data = manifest('navigation flow');
  const [main, popup] = data.pages.map((page) =>
    data.nodes.filter((item) => item.pageId === page.pageId),
  );
  const path = (item: RawNode) => new URL(item.actualUrl).pathname;
  const byPath = (items: RawNode[], pathname: string) =>
    items.find((item) => path(item) === pathname)!;
  const start = byPath(main, '/start');
  const next = byPath(main, '/next');
  const back = byPath(main, '/back');
  const replaced = byPath(main, '/a');
  const final = byPath(main, '/b');

  expect(start.previousNodeId).toBeUndefined();
  expect(next.previousNodeId).toBe(start.nodeId);
  expect(back.previousNodeId).toBe(next.nodeId);
  expect(popup).toHaveLength(1);
  expect(popup[0].previousNodeId).toBe(back.nodeId);
  // The replaced route stays in the chain.
  expect(replaced).toMatchObject({
    status: 'uncaptured',
    reason: 'navigated-away',
    previousNodeId: back.nodeId,
  });
  expect(final).toMatchObject({
    status: 'recorded',
    previousNodeId: replaced.nodeId,
  });
});

it('drops tracked elements that are off-screen horizontally', () => {
  const [start] = recordedNodes('navigation flow');
  expect(start.layout.trackedElements.map((item) => item.trackId)).toEqual([
    'next-link',
  ]);
});

it('records explicit same-URL states and overrides without changing browser location', () => {
  const items = recordedNodes('explicit URL overrides');
  expect(items).toHaveLength(4);
  expect(
    items.slice(1).map((item) => [item.state, item.actualUrl, item.url]),
  ).toEqual([
    [
      'dialog',
      'https://fixture.test/cart',
      'https://fixture.test/checkout/shipping-options',
    ],
    ['absolute', 'https://fixture.test/cart', 'https://logical.test/cart'],
    ['actual', 'https://fixture.test/cart', 'https://fixture.test/cart'],
  ]);
  expect(items[1].layout.scroll.y).toBe(600);
  expect(items[1].layout.trackedElements[0].y).toBe(40);
});

it('records during teardown before context closure and follows redirects', () => {
  expect(
    recordedNodes('teardown drains automatic recording').map(
      (item) => item.url,
    ),
  ).toEqual(['https://fixture.test/final']);
  expect(
    recordedNodes('redirect final destination').map(
      (item) => new URL(item.url).pathname,
    ),
  ).toEqual(['/destination']);
});

it('records a page whose router rewrites its history state as it loads', () => {
  expect(
    manifest('same-URL history updates').nodes.map(({ url, status }) => ({
      url,
      status,
    })),
  ).toEqual([{ url: 'https://router.test/start', status: 'recorded' }]);
});

it('reports replaced routes as uncaptured without attaching the next state screenshot to them', () => {
  const items = manifest('replaced transitions').nodes;
  expect(
    items.find((item) => item.actualUrl.endsWith('/intermediate')),
  ).toMatchObject({ status: 'uncaptured', reason: 'navigated-away' });
  expect(items.at(-1)).toMatchObject({
    status: 'recorded',
    actualUrl: 'https://fixture.test/final',
  });
  expect(manifest('replaced transitions').complete).toBe(false);
});

it('keeps popups separate and ignores subframe URL changes', () => {
  const data = manifest('popup and iframe isolation');
  expect(data.pages).toHaveLength(2);
  expect(data.pages[1].openerPageId).toBe(data.pages[0].pageId);
  expect(data.nodes.map((item) => item.actualUrl)).toEqual([
    'https://fixture.test/home',
    'https://fixture.test/popup',
  ]);
  expect(data.nodes.map((item) => item.sequence)).toEqual([0, 0]);
  expect(recordedNodes('manual context enrollment')).toHaveLength(1);
});

it('keeps retries separate and snapshots config and build identity', () => {
  const attempts = manifests.get('retry attempts')!;
  expect(attempts).toHaveLength(2);
  expect(attempts.map((item) => item.rawGraph.retry)).toEqual([0, 1]);
  expect(attempts.map((item) => item.rawGraph.complete)).toEqual([false, true]);
  expect(attempts[1]).toMatchObject({
    runId: 'browser-suite',
    buildId: 'fixture-build',
    config: { config: { screenSizes: [] } },
  });
});

it('does not enroll ordinary tests, native imports, or disabled scenarios', () => {
  for (const title of [
    'ordinary test remains unrecorded',
    'explicit recording requires opt-in',
    'off needs no config and no browser',
    'off recording is a no-op',
    'native Playwright test',
  ]) {
    expect(manifests.get(title), title).toEqual([]);
  }
  expect(recordedNodes('composes customer fixtures')).toHaveLength(1);
});

it('honors readiness and records bounded readiness failures', () => {
  expect(recordedNodes('readiness hook')).toHaveLength(1);
  expect(manifest('readiness timeout is bounded').nodes[0]).toMatchObject({
    status: 'uncaptured',
    reason: 'error',
    message: 'Ralph recording timed out.',
  });
});

it('publishes a portable screenshot attachment for every recorded node', async () => {
  for (const test of tests) {
    for (const [attemptIndex, data] of (
      manifests.get(test.title) ?? []
    ).entries()) {
      for (const item of data.rawGraph.nodes) {
        if (item.status !== 'recorded') {
          continue;
        }
        const attachment = test.results[attemptIndex].attachments.find(
          (entry) => entry.name === item.screenshot.attachmentName,
        );
        expect(attachment).toBeDefined();
        const image = await readFile(attachment!.path);
        expect(image.toString('ascii', 8, 12)).toBe('WEBP');
        expect(item.screenshot.contentType).toBe('image/webp');
        expect(item.screenshot.path).toMatch(/\.webp$/);
        expect(path.isAbsolute(item.screenshot.path)).toBe(false);
      }
    }
  }
});

it('merges the final attempt of every recorded test into one raw graph', async () => {
  const { manifest: run, screenshots } = merged;
  const recorded = [...manifests.entries()].filter(
    ([, attempts]) => attempts.length > 0,
  );
  expect(run.rawGraphs).toHaveLength(recorded.length);
  expect(run).toMatchObject({
    formatVersion: 1,
    runId: 'browser-suite',
    buildId: 'fixture-build',
    shard: null,
    config: { config: { screenSizes: [] } },
    complete: false,
  });
  const byTitle = (title: string) =>
    run.rawGraphs.find((test) => test.titlePath.at(-1) === title)!;

  // Only the retry's final attempt, with the status the run ended with.
  const retried = byTitle('retry attempts');
  const [, lastAttempt] = manifests.get('retry attempts')!;
  expect(retried).toMatchObject({ retry: 1, status: 'passed', complete: true });
  expect(retried.nodes.map((item) => item.nodeId)).toEqual(
    lastAttempt.rawGraph.nodes.map((item) => item.nodeId),
  );
  // A failed recording fails the test after its raw graph was written.
  expect(byTitle('readiness timeout is bounded')).toMatchObject({
    status: 'failed',
    complete: false,
  });

  const nodes = run.rawGraphs.flatMap((test) => test.nodes);
  expect(new Set(nodes.map((item) => item.nodeId)).size).toBe(nodes.length);
  const recordedNodes = nodes.filter((item) => item.status === 'recorded');
  expect(screenshots).toHaveLength(recordedNodes.length);
  for (const item of recordedNodes) {
    expect(item.screenshot.path).toBe(`assets/images/${item.nodeId}.webp`);
    const image = await readFile(
      path.join(output, 'artifacts', 'ralph', item.screenshot.path),
    );
    expect(image.toString('ascii', 8, 12)).toBe('WEBP');
  }
});

/** A stand-in Ralph server that checks each bundle and keeps its manifest. */
async function startUploadServer() {
  const received: RawGraphManifest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const files = await readBundle(Buffer.concat(chunks));
    const bundle = JSON.parse(
      Buffer.from(files.get('raw_graph.json')!).toString(),
    ) as RawGraphBundleIndex;
    for (const screenshot of bundle.screenshots) {
      expect(
        Buffer.from(files.get(screenshot.path)!).toString('ascii', 8, 12),
      ).toBe('WEBP');
    }
    expect(request.url).toBe('/api/upload/playwright/apps/app12345/artifact');
    expect(request.headers.authorization).toBe('Bearer test-secret');
    expect(request.headers['content-type']).toBe('application/gzip');
    expect(bundle.screenshots).toHaveLength(
      bundle.manifest.rawGraphs
        .flatMap((graph) => graph.nodes)
        .filter((item) => item.status === 'recorded').length,
    );
    received.push(bundle.manifest);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        result: 'ok',
        status: 'received',
        artifactId: bundle.manifest.artifactId,
        resultId: 'result-1',
        resultUrl: 'https://dash.example/uploads/result-1',
        replayed: false,
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    received,
    env: {
      RALPH_UPLOAD_KEY: 'test-secret',
      RALPH_APP_ID: 'app12345',
      RALPH_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    },
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

const playwrightCli = () =>
  path.join(
    path.dirname(require.resolve('@playwright/test/package.json')),
    'cli.js',
  );

it.each(['always', 'failures-only', 'never'])(
  'uploads the whole run with preserveOutput=%s and prints its link',
  async (preserveOutput) => {
    const server = await startUploadServer();
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [playwrightCli(), 'test', '--config', 'test/playwright.config.ts'],
        {
          cwd: path.resolve(import.meta.dirname, '..'),
          env: {
            ...process.env,
            ...server.env,
            RALPH_TEST_UPLOAD: '1',
            RALPH_TEST_PRESERVE_OUTPUT: preserveOutput,
            RALPH_TEST_OUTPUT: path.join(output, 'upload'),
            RALPH_TEST_REPORT: path.join(output, 'upload-report.json'),
          },
          timeout: 80_000,
        },
      );
      expect(server.received).toHaveLength(1);
      const [run] = server.received;
      // Tests in local mode are part of the run too.
      expect(run.rawGraphs).toHaveLength(merged.manifest.rawGraphs.length);
      expect(
        run.rawGraphs.find((graph) =>
          graph.titlePath.includes('retry attempts'),
        ),
      ).toMatchObject({ retry: 1, status: 'passed' });
      expect(stdout).toContain('https://dash.example/uploads/result-1');
      if (preserveOutput === 'never') {
        expect(
          (await readdir(path.join(output, 'upload'))).filter(
            (name) => name !== 'ralph' && name !== '.last-run.json',
          ),
        ).toEqual([]);
      }
      expect(
        JSON.parse(
          await readFile(
            path.join(output, 'upload', 'ralph', 'upload_receipt.json'),
            'utf8',
          ),
        ),
      ).toMatchObject({ resultId: 'result-1' });
    } finally {
      await server.close();
    }
  },
);

it('merges a sharded run from its blob reports and uploads it once', async () => {
  const blobs = path.join(output, 'blobs');
  const cwd = path.resolve(import.meta.dirname, '..');
  // The shards record in upload mode with no credentials; only the merge
  // step uploads. Each shard gets its own blob file only because both run on
  // this machine, and the blob reporter empties its output directory first.
  for (const shard of [1, 2]) {
    await promisify(execFile)(
      process.execPath,
      [
        playwrightCli(),
        'test',
        '--config',
        'test/playwright.config.ts',
        `--shard=${shard}/2`,
        '--reporter',
        'blob',
      ],
      {
        cwd,
        env: {
          ...process.env,
          RALPH_TEST_UPLOAD: '1',
          RALPH_UPLOAD_KEY: '',
          RALPH_TEST_PRESERVE_OUTPUT: 'never',
          RALPH_TEST_OUTPUT: path.join(output, `shard-${shard}`),
          PLAYWRIGHT_BLOB_OUTPUT_FILE: path.join(blobs, `report-${shard}.zip`),
        },
        timeout: 80_000,
      },
    );
  }

  const server = await startUploadServer();
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        playwrightCli(),
        'merge-reports',
        '--reporter',
        path.join(cwd, 'dist', 'reporter.mjs'),
        blobs,
      ],
      {
        cwd,
        env: { ...process.env, ...server.env },
        timeout: 80_000,
      },
    );
    expect(server.received).toHaveLength(1);
    const [run] = server.received;
    expect(run.shard).toBeNull();
    expect(run.rawGraphs.map((graph) => graph.titlePath.at(-1)).sort()).toEqual(
      merged.manifest.rawGraphs.map((graph) => graph.titlePath.at(-1)).sort(),
    );
    expect(
      run.rawGraphs.find((graph) => graph.titlePath.includes('retry attempts')),
    ).toMatchObject({ retry: 1, status: 'passed' });
    expect(stdout).toContain('https://dash.example/uploads/result-1');
  } finally {
    await server.close();
  }
});

it('refuses to upload without the reporter', async () => {
  const run = promisify(execFile)(
    process.execPath,
    [
      playwrightCli(),
      'test',
      '--config',
      'test/playwright.config.ts',
      '--reporter',
      'line',
      '--grep',
      'teardown drains',
      '--retries',
      '0',
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        RALPH_TEST_UPLOAD: '1',
        RALPH_UPLOAD_KEY: 'test-secret',
        RALPH_APP_ID: 'app12345',
        RALPH_API_URL: 'http://127.0.0.1:9',
        RALPH_TEST_OUTPUT: path.join(output, 'no-reporter'),
      },
      timeout: 80_000,
    },
  );
  await expect(run).rejects.toMatchObject({
    stdout: expect.stringContaining('@ralphralphai/playwright/reporter'),
  });
});

it('waits for finite animations when reduceMotion is on', () => {
  const [item] = recordedNodes('reduced motion waits for animations');
  expect(item.layout.trackedElements).toEqual([
    { trackId: 'slide', x: 120, y: 40, width: 120, height: 32 },
  ]);
  expect(item.geometryStable).toBe(true);
});

it('leaves animations running after a screenshot', () => {
  expect(
    recordedNodes('infinite animations resume after the screenshot'),
  ).toHaveLength(1);
});

it('drops paused steps from the graph', () => {
  const items = manifest('paused capture').nodes;
  expect(items.map((item) => item.url)).toEqual([
    'https://fixture.test/a',
    'https://fixture.test/d',
  ]);
  expect(items[1].previousNodeId).toBe(items[0].nodeId);
});

it('links across pages used while paused', () => {
  const { nodes, pages } = manifest('paused capture across pages');
  expect(nodes.map((item) => item.url)).toEqual([
    'https://fixture.test/a',
    'https://fixture.test/d',
  ]);
  expect(nodes[1].pageId).not.toBe(nodes[0].pageId);
  expect(nodes[1].previousNodeId).toBe(nodes[0].nodeId);
  expect(pages).toHaveLength(3);
});
