import { test, expect } from '../dist/index.mjs';

test.use({
  launchOptions: { executablePath: '/ralph-no-browser-installed' },
  ralphOptions: { mode: 'off', configPath: '/ralph-no-config.jsonc' },
});

test(
  'off needs no config and no browser',
  { tag: '@ralph' },
  async ({ ralph }) => {
    await ralph.flush();
  },
);

test.describe('unmarked tests', () => {
  test.use({
    ralphOptions: { mode: 'local', configPath: '/ralph-no-config.jsonc' },
  });
  test('ordinary API tests do not launch a browser or load config', async ({
    request,
  }) => {
    expect(request).toBeDefined();
  });
});
