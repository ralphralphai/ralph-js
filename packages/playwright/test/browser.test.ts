import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from 'vitest';

import type { RawGraphManifest, RawNode } from '../src/types';
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
const manifests = new Map<string, RawGraphManifest[]>();
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
          JSON.parse(await readFile(artifact.path, 'utf8')) as RawGraphManifest,
        );
      }
    }
    manifests.set(test.title, records);
  }
});

afterAll(async () => {
  if (output) {
    await rm(output, { recursive: true, force: true });
  }
});

function manifest(title: string): RawGraphManifest {
  const item = manifests.get(title)?.[0];
  expect(item).toBeDefined();
  return item!;
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
  // The superseded route is skipped.
  expect(replaced.status).toBe('superseded');
  expect(final).toMatchObject({
    status: 'recorded',
    previousNodeId: back.nodeId,
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

it('reports superseded routes without attaching the next state screenshot to them', () => {
  const items = manifest('superseded transitions').nodes;
  expect(
    items.find((item) => item.actualUrl.endsWith('/intermediate'))?.status,
  ).toBe('superseded');
  expect(items.at(-1)).toMatchObject({
    status: 'recorded',
    actualUrl: 'https://fixture.test/final',
  });
  expect(manifest('superseded transitions').complete).toBe(false);
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
  expect(attempts.map((item) => item.test.retry)).toEqual([0, 1]);
  expect(attempts[0].attemptId).not.toBe(attempts[1].attemptId);
  expect(attempts.map((item) => item.complete)).toEqual([false, true]);
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
    status: 'failed',
    reason: 'Ralph recording timed out.',
  });
});

it('publishes a portable screenshot attachment for every recorded node', async () => {
  for (const test of tests) {
    for (const [attemptIndex, data] of (
      manifests.get(test.title) ?? []
    ).entries()) {
      for (const item of data.nodes) {
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

it('uploads opted-in attempts as compressed blobs while retaining local artifacts', async () => {
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
    expect(request.url).toBe('/api/upload/playwright/apps/app12345/attempts');
    expect(request.headers.authorization).toBe('Bearer test-secret');
    expect(request.headers['content-type']).toBe('application/gzip');
    expect(bundle.screenshots).toHaveLength(
      bundle.manifest.nodes.filter((item) => item.status === 'recorded').length,
    );
    received.push(bundle.manifest);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        result: 'ok',
        status: 'received',
        attemptId: bundle.manifest.attemptId,
        resultId: 'result-1',
        replayed: false,
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const cli = path.join(
      path.dirname(require.resolve('@playwright/test/package.json')),
      'cli.js',
    );
    await promisify(execFile)(
      process.execPath,
      [cli, 'test', '--config', 'test/playwright.config.ts'],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
          ...process.env,
          RALPH_TEST_UPLOAD: '1',
          RALPH_UPLOAD_KEY: 'test-secret',
          RALPH_APP_ID: 'app12345',
          RALPH_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          RALPH_TEST_OUTPUT: path.join(output, 'upload'),
          RALPH_TEST_REPORT: path.join(output, 'upload-report.json'),
        },
        timeout: 80_000,
      },
    );
    const local = [...manifests.entries()]
      .filter(
        ([title]) =>
          !['readiness hook', 'readiness timeout is bounded'].includes(title),
      )
      .flatMap(([, attempts]) => attempts);
    expect(received).toHaveLength(local.length);
    expect(
      received.some((item) => item.test.titlePath.includes('readiness hook')),
    ).toBe(false);
    expect(
      received.filter((item) => item.test.retry === 1).length,
    ).toBeGreaterThan(0);
    expect(received.some((item) => item.test.status === 'failed')).toBe(true);
    expect(new Set(received.map((item) => item.attemptId)).size).toBe(
      received.length,
    );
  } finally {
    server.close();
    await once(server, 'close');
  }
});
