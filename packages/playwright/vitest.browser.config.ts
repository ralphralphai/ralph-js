import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/browser.test.ts', 'test/screens.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
