import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/browser.test.ts',
      'test/screens.test.ts',
      'test/image_responses.test.ts',
      'test/capture_freezer.test.ts',
    ],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
