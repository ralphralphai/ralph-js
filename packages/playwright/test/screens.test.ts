import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from 'vitest';

import type { RawGraphManifest } from '../src/types';

type Result = {
  status: string;
  errors: { message?: string }[];
  attachments: { name: string; path: string }[];
};
type ReportSuite = {
  suites?: ReportSuite[];
  specs?: {
    title: string;
    tests: { projectName: string; results: Result[] }[];
  }[];
};

const require = createRequire(import.meta.url);
const results = new Map<string, Result>();
let output: string;

beforeAll(async () => {
  output = await mkdtemp(path.join(os.tmpdir(), 'ralph-screens-'));
  const reportPath = path.join(output, 'report.json');
  const cli = path.join(
    path.dirname(require.resolve('@playwright/test/package.json')),
    'cli.js',
  );
  // The unknown-size scenario fails deliberately, so the CLI exits non-zero.
  await promisify(execFile)(
    process.execPath,
    [cli, 'test', '--config', 'test/screens.config.ts'],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        RALPH_TEST_OUTPUT: path.join(output, 'artifacts'),
        RALPH_TEST_REPORT: reportPath,
      },
      timeout: 80_000,
    },
  ).catch(() => {});
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as ReportSuite;
  const visit = (suite: ReportSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        results.set(test.projectName + ' / ' + spec.title, test.results[0]);
      }
    }
    (suite.suites ?? []).forEach(visit);
  };
  visit(report);
});

afterAll(async () => {
  if (output) {
    await rm(output, { recursive: true, force: true });
  }
});

async function viewport(key: string) {
  const attachment = results
    .get(key)!
    .attachments.find((item) => item.name === 'ralph-raw-graph');
  const manifest = JSON.parse(
    await readFile(attachment!.path, 'utf8'),
  ) as RawGraphManifest;
  const [node] = manifest.nodes;
  return node.status === 'recorded' ? node.layout.viewport : undefined;
}

it('runs untagged tests at every configured screen size', async () => {
  expect(await viewport('chromium 375x812 / every screen size')).toEqual({
    width: 375,
    height: 812,
  });
  expect(await viewport('chromium 768x1024 / every screen size')).toEqual({
    width: 768,
    height: 1024,
  });
  expect(await viewport('chromium 1280x720 / every screen size')).toEqual({
    width: 1280,
    height: 720,
  });
});

it('runs tagged tests and describe groups only at selected sizes', async () => {
  expect(results.get('chromium 375x812 / mobile only')?.status).toBe('passed');
  expect(results.get('chromium 1280x720 / mobile only')?.status).toBe(
    'skipped',
  );
  expect(results.get('chromium 375x812 / desktop only')?.status).toBe(
    'skipped',
  );
  expect(await viewport('chromium 1280x720 / desktop only')).toEqual({
    width: 1280,
    height: 720,
  });
  expect(
    results.get('chromium 375x812 / unrecorded tests are filtered too')?.status,
  ).toBe('passed');
  expect(
    results.get('chromium 1280x720 / unrecorded tests are filtered too')
      ?.status,
  ).toBe('skipped');
});

it('runs tests that select several sizes at each of them', async () => {
  expect(results.get('chromium 375x812 / tablet and desktop')?.status).toBe(
    'skipped',
  );
  expect(await viewport('chromium 768x1024 / tablet and desktop')).toEqual({
    width: 768,
    height: 1024,
  });
  expect(await viewport('chromium 1280x720 / tablet and desktop')).toEqual({
    width: 1280,
    height: 720,
  });
});

it('fails tests that select a size missing from the config', () => {
  const result = results.get('chromium 375x812 / unknown screen size')!;
  expect(result.status).toBe('failed');
  expect(result.errors[0].message).toContain('Unknown Ralph screen size 1x1');
});
