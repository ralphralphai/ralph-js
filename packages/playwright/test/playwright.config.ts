import { defineConfig } from '@playwright/test';

import type { RalphFixtures } from '../src';

export default defineConfig<RalphFixtures>({
  testDir: '.',
  testMatch: ['scenarios.spec.ts', 'no-browser.spec.ts'],
  outputDir: process.env['RALPH_TEST_OUTPUT'],
  preserveOutput: 'always',
  workers: 2,
  retries: 1,
  reporter: [['json', { outputFile: process.env['RALPH_TEST_REPORT'] }]],
  use: {
    browserName: 'chromium',
    viewport: { width: 500, height: 400 },
    deviceScaleFactor: 2,
    ralphOptions: {
      mode: process.env['RALPH_TEST_UPLOAD'] === '1' ? 'upload' : 'local',
      config: { screenSizes: [] },
      runId: 'browser-suite',
      buildId: 'fixture-build',
      settleMs: 0,
      captureTimeoutMs: 3000,
    },
  },
});
