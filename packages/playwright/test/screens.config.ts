import { defineConfig } from '@playwright/test';

import { ralphProjects, type RalphFixtures } from '../dist/index.mjs';

const config = {
  screenSizes: [
    { width: 375, height: 812 },
    { width: 768, height: 1024 },
    { width: 1280, height: 720 },
  ],
};

export default defineConfig<RalphFixtures>({
  testDir: '.',
  testMatch: ['screens.spec.ts'],
  outputDir: process.env['RALPH_TEST_OUTPUT'],
  preserveOutput: 'always',
  reporter: [['json', { outputFile: process.env['RALPH_TEST_REPORT'] }]],
  use: {
    ralphOptions: { mode: 'local', config, settleMs: 0 },
  },
  projects: ralphProjects(
    { name: 'chromium', use: { browserName: 'chromium' } },
    { config },
  ),
});
