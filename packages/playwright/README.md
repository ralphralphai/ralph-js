# @ralphralphai/playwright

Turn your Playwright tests into a map of your app for
[Ralph](https://ralphralph.ai).

Tag a test with `@ralph` and every page it visits is recorded: a full-page
screenshot, the URL, and the position of every element carrying a
`data-track-id`. Ralph builds a navigation graph from those recordings and
overlays real user interactions on the screenshots as heatmaps.

Your tests keep driving the app exactly as they do today. Untagged tests are
untouched, and recording is off unless you turn it on.

## Install

Requires Node.js 20.19+ and Playwright Test 1.62.1+ (major version 1).

```sh
pnpm add -D @ralphralphai/playwright @playwright/test
pnpm exec playwright install chromium
```

## Quick start

**1. Add a `ralph.jsonc`** next to `playwright.config.ts`, listing the screen
sizes to record at:

```jsonc
{
  "$schema": "./node_modules/@ralphralphai/config/schema/ralph.schema.json",
  "screenSizes": [{ "width": 1280, "height": 720 }]
}
```

See [`@ralphralphai/config`](https://www.npmjs.com/package/@ralphralphai/config)
for everything the file can declare.

**2. Import `test` from this package and tag the tests to record:**

```ts
import { test, expect } from '@ralphralphai/playwright';

test('checkout', { tag: '@ralph' }, async ({ page }) => {
  await page.goto('https://example.com/cart');
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/checkout/);
});
```

Every URL the test reaches is recorded automatically. You don't need to call
anything.

**3. Run with recording on:**

```sh
RALPH_MODE=local pnpm exec playwright test
```

Recordings are saved into Playwright's test output directory. To send them to
Ralph instead, see [Uploading to Ralph](#uploading-to-ralph).

## Tag your elements

Ralph records the position of every visible element with a `data-track-id`, so
it can place heatmap data on the screenshot. Use the same ids your
[`@ralphralphai/tracker`](https://www.npmjs.com/package/@ralphralphai/tracker)
setup uses:

```html
<button data-track-id="add-to-cart">Add to cart</button>
```

## Recording pages

### Automatically, on every URL change

In a `@ralph` test, Ralph records a page whenever the URL changes in any tab of
the test's browser context:

- full page loads, redirects (the final page), and SPA route changes
- query-string and hash changes
- new tabs and popups

It does not record `about:blank`, iframes, reloads of the same URL, or changes
to the page that don't change the URL.

Each recording waits for the DOM to load, then another 150 ms (`settleMs`) for
the page to render. If your app needs longer, use the `ready` option to say when
a page is ready:

```ts
ralphOptions: {
  ready: async (page, signal) => {
    await page.getByTestId('app-ready').waitFor({ timeout: 3000 });
  },
},
```

### Explicitly, for states at the same URL

Dialogs, menus, and tabs often change the page without changing the URL. Record
them with `ralph.recordNode`:

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

`recordNode` records the page as it is right now, without waiting for it to
settle, so call it after your assertions. The `url` option only changes what is
recorded; the browser doesn't navigate. Relative URLs resolve against the
current page.

### Waiting for recordings

Recording runs in the background, so your test isn't slowed down. If the test
moves on before a screenshot finishes, that recording is marked `superseded`
rather than attributed to the wrong page. When you need a page recorded before
leaving it, wait for pending recordings first:

```ts
await page.goto('https://example.com/pricing');
await ralph.flush(); // make sure /pricing is recorded
await page.goto('https://example.com/signup');
```

### Browser contexts you create yourself

The standard `context` and `page` fixtures are recorded for you. For a context
you create yourself, enroll it, and flush before closing it:

```ts
const context = await browser.newContext();
ralph.observe(context);
// ...
await ralph.flush();
await context.close();
```

### When recording fails

- An explicit `recordNode` call that fails rejects, like any other failing
  step.
- A failed automatic recording fails an otherwise passing test at the end, so
  missing pages don't go unnoticed. The reason is recorded with the results.
- A superseded recording, or a page whose layout moved during its screenshot,
  doesn't fail the test.

## Modes

Set the mode with `RALPH_MODE` or the `mode` option:

| Mode     | What happens                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `off`    | Default. Nothing is recorded, no Ralph config or credentials are needed, and `ralph.recordNode` does nothing.                              |
| `local`  | `@ralph` tests are recorded into Playwright's output directory.                                                                          |
| `upload` | As `local`, and each test's recordings are uploaded to Ralph when it finishes. Chosen automatically when `RALPH_UPLOAD_KEY` is set and no mode is. |

Tests without the `@ralph` tag are never recorded, in any mode. In `local` or
`upload` mode, calling `ralph.recordNode` in an untagged test throws a reminder
to add the tag.

Tests that import from `@playwright/test` directly keep working alongside Ralph
tests.

## Uploading to Ralph

1. Create an upload key for your Ralph project with the authenticated
   `/api/project/key/create` endpoint. One key covers every app in the project.
   Keep it in your CI secrets.
2. Set these, as environment variables or options:

   | Variable           | Option   | Value                                  |
   | ------------------ | -------- | -------------------------------------- |
   | `RALPH_UPLOAD_KEY` |          | The upload key. Environment only.      |
   | `RALPH_API_URL`    | `apiUrl` | Your Ralph server, e.g. `https://…`    |
   | `RALPH_APP_ID`     | `appId`  | The app these recordings belong to     |

3. Run:

   ```sh
   RALPH_MODE=upload RALPH_API_URL=https://your-ralph-server.example RALPH_APP_ID=<app id> \
     pnpm exec playwright test
   ```

Each attempt of a `@ralph` test uploads once when it finishes. The upload
receipt is attached to the test as `ralph-upload-receipt`, and its `resultId`
opens the upload in the Ralph dashboard at `/uploads/<resultId>`. The upload key
is never written to the results or the receipt.

`RALPH_API_URL` must be HTTPS. Plain HTTP is accepted only for `localhost`,
`127.x.x.x`, and `[::1]`, for local development.

If an upload fails, the test fails.

## Screen sizes

A browser context's viewport is fixed, so each entry in `screenSizes` becomes
its own Playwright project. `ralphProjects` expands one project into one per
size:

```ts
import { defineConfig, devices } from '@playwright/test';
import { ralphProjects, type RalphFixtures } from '@ralphralphai/playwright';

export default defineConfig<RalphFixtures>({
  projects: [
    // Ordinary tests keep their single project.
    { name: 'chromium', grepInvert: /@ralph\b/, use: devices['Desktop Chrome'] },
    // With screenSizes 375x812 and 1280x720, this creates the projects
    // "chromium 375x812" and "chromium 1280x720".
    ...ralphProjects({
      name: 'chromium',
      grep: /@ralph\b/,
      use: devices['Desktop Chrome'],
    }),
  ],
});
```

`ralphProjects` reads `ralph.jsonc` from the current directory. If Playwright
runs from elsewhere, pass `{ root: import.meta.dirname }` (or `__dirname`), or
an inline `config`, as the second argument. Keep it pointing at the same config
as `ralphOptions`.

A test runs at every size by default. A mobile flow is usually a different test
from its desktop flow, so tag a test or `describe` block with
`@ralph-screen:WIDTHxHEIGHT`, once per size, to run it only at those sizes:

```ts
test(
  'mobile navigation',
  { tag: ['@ralph', '@ralph-screen:375x812'] },
  async ({ page }) => {
    await page.getByRole('button', { name: 'Menu' }).click();
  },
);

test.describe('desktop layouts', { tag: '@ralph-screen:1280x720' }, () => {
  test('sidebar', { tag: '@ralph' }, async ({ page }) => {});
});
```

- Tags on a `describe` block and its tests combine.
- Screen tags apply in every mode, because they choose which tests run.
- A size missing from `screenSizes` fails the test, so a typo can't silently
  skip it.
- Projects not created by `ralphProjects` ignore screen tags.

To run one size: `playwright test --project "chromium 375x812"`.

## Options

Set `ralphOptions` in `playwright.config.ts`, or per file with `test.use`:

```ts
import { defineConfig } from '@playwright/test';
import type { RalphFixtures } from '@ralphralphai/playwright';

export default defineConfig<RalphFixtures>({
  use: {
    ralphOptions: {
      mode: 'local',
      configPath: './ralph.jsonc',
      buildId: process.env.GIT_SHA,
      settleMs: 300,
    },
  },
});
```

| Option            | Default               | What it does                                                                                     |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `mode`            | `RALPH_MODE`, else `off` | `off`, `local`, or `upload`. See [Modes](#modes).                                              |
| `configPath`      | `ralph.jsonc`         | Path to the config, relative to the Playwright config's directory.                               |
| `config`          |                       | An inline config instead of a file.                                                              |
| `apiUrl`          | `RALPH_API_URL`       | Your Ralph server, for uploads.                                                                  |
| `appId`           | `RALPH_APP_ID`        | The app recordings belong to, for uploads.                                                       |
| `uploadTimeoutMs` | 30000                 | How long an upload may take.                                                                     |
| `buildId`         | `RALPH_BUILD_ID`      | Your app's build, so recordings line up with the analytics from that build.                      |
| `runId`           | `RALPH_RUN_ID`        | Groups the tests of one CI run.                                                                  |
| `settleMs`        | 150                   | How long to wait after the DOM loads before an automatic recording.                              |
| `recordTimeoutMs` | 5000                  | How long one recording may take, including settling and `ready`. Must be more than `settleMs`.   |
| `ready`           |                       | `(page, signal) => Promise<void>`. Waits for your app to be ready before an automatic recording. |

`ready` is bounded by `recordTimeoutMs`. Ralph stops waiting when time runs out
but can't cancel your code, so honor `signal` or use Playwright operations with
their own timeouts.

Config files accept comments and trailing commas, and are validated when the
first `@ralph` test in a worker starts. Keep the config unchanged during a run.

For an inline config, the type is re-exported:

```ts
import type { WebRalphConfig } from '@ralphralphai/playwright';

const config: WebRalphConfig = { screenSizes: [{ width: 1280, height: 720 }] };
```

## Limits

Per test attempt: 500 screenshots, 64 MiB of screenshots, 2 MiB of recorded
data besides the screenshots, and 64 MiB compressed. The server accepts up to
5,000 recorded pages. Split larger flows into several tests.

## License

Apache-2.0
