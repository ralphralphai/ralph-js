# @ralphralphai/playwright

Turn your Playwright tests into a map of your app for
[Ralph](https://ralphralph.ai).

Tag a test with `@ralph` and every page it visits is recorded: a full-page
screenshot, the URL, and the position of every element with a `data-track-id`.
Untagged tests are untouched, and recording is off unless you turn it on.

## Install

Requires Node.js 20.19+ and Playwright Test 1.62.1+ (major version 1).

```sh
pnpm add -D @ralphralphai/playwright @playwright/test
pnpm exec playwright install chromium
```

## Quick start

**1. Add a `ralph.jsonc`** next to `playwright.config.ts`:

```jsonc
{
  "$schema": "./node_modules/@ralphralphai/config/schema/ralph.schema.json",
  "screenSizes": [{ "width": 1280, "height": 720 }]
}
```

See [`@ralphralphai/config`](https://www.npmjs.com/package/@ralphralphai/config)
for all fields.

**2. Import `test` from this package and tag tests with `@ralph`:**

```ts
import { test, expect } from '@ralphralphai/playwright';

test('checkout', { tag: '@ralph' }, async ({ page }) => {
  await page.goto('https://example.com/cart');
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/checkout/);
});
```

**3. Add the Ralph reporter** in `playwright.config.ts`:

```ts
export default defineConfig({
  reporter: [['list'], ['@ralphralphai/playwright/reporter']],
});
```

**4. Run with your upload key** (see [Uploading to Ralph](#uploading-to-ralph)):

```sh
RALPH_UPLOAD_KEY=… RALPH_APP_ID=… pnpm exec playwright test
```

## Tag your elements

Add `data-track-id` to elements, using the same ids as your
[`@ralphralphai/tracker`](https://www.npmjs.com/package/@ralphralphai/tracker)
setup:

```html
<button data-track-id="add-to-cart">Add to cart</button>
```

## Recording pages

### Automatically

A page is recorded whenever the URL changes in any tab of the test: page loads,
redirects (the final page), SPA route changes, query and hash changes, and new
tabs and popups. Reloads, iframes, `about:blank`, and changes that keep the URL
are not recorded.

Each recording waits for the DOM to load plus `settleMs` (150 ms). If your app
needs longer, use `ready`:

```ts
ralphOptions: {
  ready: async (page, signal) => {
    await page.getByTestId('app-ready').waitFor({ timeout: 3000 });
  },
},
```

CSS animations and transitions are frozen for the screenshot. For animations
driven from JavaScript, set `reduceMotion` if your app honors
`prefers-reduced-motion`.

### Explicitly, for states at the same URL

For dialogs, menus, and tabs, call `ralph.recordNode` after your assertions:

```ts
test('shipping options', { tag: '@ralph' }, async ({ page, ralph }) => {
  await page.goto('https://example.com/cart');
  await page.getByRole('button', { name: 'Shipping options' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await ralph.recordNode(page, {
    state: 'shipping-options-open',   // a label for this state
    url: '/checkout/shipping-options', // optional: the URL to record it under
  });
});
```

`url` only changes what is recorded; the browser doesn't navigate.

### Waiting for capture

Recordings run in the background. If the test leaves a page before its
screenshot is done, the page is `uncaptured`: it's in the graph without a
screenshot. To make sure a page is captured before leaving it:

```ts
await page.goto('https://example.com/pricing');
await ralph.waitForCapture();
await page.goto('https://example.com/signup');
```

### Pausing capture

To leave steps out of the graph:

```ts
await page.goto('https://example.com/a');
ralph.pause();
await page.goto('https://example.com/b'); // not recorded
await page.goto('https://example.com/c'); // not recorded
ralph.resume();
await page.goto('https://example.com/d'); // recorded, linked from /a
```

This works across tabs. While paused, `recordNode` does nothing. `resume` does
not record the current page.

### Browser contexts you create yourself

```ts
const context = await browser.newContext();
ralph.observe(context);
// ...
await ralph.waitForCapture();
await context.close();
```

### When recording fails

- A failed `recordNode` call rejects.
- A failed automatic recording fails the test at the end.
- Pages left before capture, and pages whose layout moved during the
  screenshot, don't fail the test.

## Modes

Set with `RALPH_MODE` or the `mode` option:

| Mode     | What happens                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------- |
| `off`    | Default. Nothing is recorded, and no config or credentials are needed.                          |
| `upload` | `@ralph` tests are recorded, and the reporter uploads the run. Default when `RALPH_UPLOAD_KEY` is set. |

Untagged tests are never recorded. In `upload` mode, calling
`ralph.recordNode` in an untagged test throws.

## Uploading to Ralph

1. Create an upload key for your project in the project dashboard.
2. Set these as environment variables, or `appId` as
   [reporter options](#reporter-options):

   | Variable           | Value                                              |
   | ------------------ | -------------------------------------------------- |
   | `RALPH_UPLOAD_KEY` | The upload key. Environment only.                  |
   | `RALPH_APP_ID`     | The app the recordings belong to.                  |

3. Run:

   ```sh
   RALPH_MODE=upload pnpm exec playwright test
   ```

The reporter uploads the whole run once. It prints the result link before the
upload starts, so you can open it straight away and watch the run upload and
then be processed:

```
Ralph: uploading the run. Follow the upload and processing at https://dash.ralphralph.ai/uploads/0f6c6a2e-…
Ralph: uploaded the run. Ralph is processing it at https://dash.ralphralph.ai/uploads/0f6c6a2e-…
```

### Sharded runs

Use the `blob` reporter on each shard, then merge with the Ralph reporter:

```sh
# Each shard (no upload credentials needed):
RALPH_MODE=upload pnpm exec playwright test --shard=1/4 --reporter blob

# Once, after collecting every shard's blob-report/ into all-blob-reports/:
RALPH_MODE=upload RALPH_UPLOAD_KEY=… RALPH_APP_ID=… \
  pnpm exec playwright merge-reports --reporter @ralphralphai/playwright/reporter ./all-blob-reports
```

## Screen sizes

Use `ralphProjects` to create one project per entry in `screenSizes`:

```ts
import { defineConfig, devices } from '@playwright/test';
import { ralphProjects, type RalphFixtures } from '@ralphralphai/playwright';

export default defineConfig<RalphFixtures>({
  projects: [
    { name: 'chromium', grepInvert: /@ralph\b/, use: devices['Desktop Chrome'] },
    // Creates "chromium 375x812", "chromium 1280x720", …
    ...ralphProjects({
      name: 'chromium',
      grep: /@ralph\b/,
      use: devices['Desktop Chrome'],
    }),
  ],
});
```

`ralphProjects` reads `ralph.jsonc` from the current directory. Otherwise pass
`{ root: import.meta.dirname }` or an inline `config` as the second argument.

A test runs at every size. To run it only at some sizes, tag it or its
`describe` block with `@ralph-screen:WIDTHxHEIGHT`, once per size:

```ts
test('mobile navigation', { tag: ['@ralph', '@ralph-screen:375x812'] }, async ({ page }) => {
  await page.getByRole('button', { name: 'Menu' }).click();
});

test.describe('desktop layouts', { tag: '@ralph-screen:1280x720' }, () => {
  test('sidebar', { tag: '@ralph' }, async ({ page }) => {});
});
```

A size missing from `screenSizes` fails the test.

To run one size: `playwright test --project "chromium 375x812"`.

## Options

Set `ralphOptions` in `playwright.config.ts`, or per file with `test.use`:

```ts
export default defineConfig<RalphFixtures>({
  use: {
    ralphOptions: { buildId: process.env.GIT_SHA, settleMs: 300 },
  },
});
```

| Option            | Default                  | What it does                                                                                    |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `mode`            | `RALPH_MODE`, else `off` | `off` or `upload`. See [Modes](#modes).                                                         |
| `configPath`      | `ralph.jsonc`            | Path to the config, relative to the Playwright config.                                          |
| `config`          |                          | An inline config instead of a file (type: `WebRalphConfig`).                                    |
| `buildId`         | `RALPH_BUILD_ID`         | Your app's build, to line up recordings with its analytics.                                     |
| `runId`           | `RALPH_RUN_ID`           | Identifies the CI run.                                                                          |
| `settleMs`        | 150                      | Wait after the DOM loads before an automatic recording.                                         |
| `recordTimeoutMs` | 5000                     | Budget for one recording, including `settleMs` and `ready`. Must exceed `settleMs`.             |
| `ready`           |                          | `(page, signal) => Promise<void>`. Waits for your app before an automatic recording. Honor `signal`. |
| `reduceMotion`    | `false`                  | Emulates `prefers-reduced-motion: reduce` and waits for finite animations before recording.     |

## Reporter options

```ts
reporter: [['list'], ['@ralphralphai/playwright/reporter', { appId: 'my-app' }]],
```

| Option            | Default                                           | What it does                                    |
| ----------------- | ------------------------------------------------- | ----------------------------------------------- |
| `mode`            | `RALPH_MODE`, else `upload` if `RALPH_UPLOAD_KEY` | `upload` uploads the run.                       |
| `appId`           | `RALPH_APP_ID`                                    | The app the recordings belong to.               |
| `uploadTimeoutMs` | 120000                                            | Upload timeout.                                 |
| `outputDir`       | `ralph/` in the first project's output directory  | Where the merged graph is written.              |

The run is also uploaded when any test ran in `upload` mode.

## Limits

Per run: 5,000 screenshots, 256 MiB of screenshots, 16 MiB of other recorded
data, 256 MiB compressed, 20,000 recorded pages, and 5,000 recorded pages per
test.

## License

Apache-2.0
