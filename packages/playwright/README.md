# @ralphralphai/playwright

Turn your Playwright tests into a map of your app for
[Ralph](https://ralphralph.ai).

Tag a test with `@ralph` and every page it visits is recorded: a full-page
screenshot, the URL, and the position of every element with a `data-track-id`.
Untagged tests are untouched, and recording is off unless you turn it on.

## Install

Requires Node.js 20.19+ and Playwright Test 1.63+ (major version 1).

```sh
pnpm add -D @ralphralphai/playwright @playwright/test
pnpm exec playwright install chromium
```

## Quick start

**1. Add a `ralph.jsonc`** next to `playwright.config.ts`:

```jsonc
{
  "$schema": "./node_modules/@ralphralphai/config/schema/ralph.schema.json",
  "screenSizes": [{ "width": 1280, "height": 720 }],
}
```

See [`@ralphralphai/config`](https://www.npmjs.com/package/@ralphralphai/config)
for all fields.

**2. Import `test` from this package and tag tests with `@ralph`:**

```ts
import { test, expect } from "@ralphralphai/playwright";

test("checkout", { tag: "@ralph" }, async ({ page }) => {
  await page.goto("https://example.com/cart");
  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/checkout/);
});
```

**3. Add the Ralph reporter** in `playwright.config.ts`:

```ts
export default defineConfig({
  reporter: [["list"], ["@ralphralphai/playwright/reporter"]],
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

Screenshots are WebP. A page taller or wider than 16,383 px, the most WebP can
hold, is recorded up to that size, and what lies beyond it has no screenshot.

CSS animations and transitions are frozen for the screenshot. For animations
driven from JavaScript, set `reduceMotion` if your app honors
`prefers-reduced-motion`.

To hold timers and animations at the same position across the screenshot,
tracked-element geometry, and ARIA snapshot, enable:

```ts
ralphOptions: {
  freezeDuringCapture: true,
},
```

Ralph installs Playwright's clock before the app loads. Before capture it
finishes running finite CSS transitions, CSS animations, and Web Animations,
and watches DOM changes in the page, its frames, and open shadow roots. Timers
and animation frames keep running while it waits for 150 ms without changes,
so JavaScript-driven animations can finish without adding callbacks or markers
to your app. Animations started by completion callbacks are checked again.

This extra settling wait is capped at 1.5 seconds, or half the remaining
`recordTimeoutMs` budget, whichever is smaller. Looping browser animations are
temporarily paused while settling. Then timers and all remaining browser
animations pause during capture and resume afterward, including on failure.
Animations already paused by the app stay paused; finished animations stay
finished.

The DOM quiet check is a heuristic, not a guarantee that every animation has
ended. Long-running JavaScript animations can be captured midway when the
budget expires. Future delayed work and drawing inside canvas or WebGL aren't
detected by this check.

This option defaults to `false`. The clock replaces the native timer APIs for
the lifetime of the context, so don't combine it with manual `page.clock` or
`context.clock` control. Playwright requires a future pause time: Ralph uses
the page's current time plus 100 ms, which advances the clock and can fire due
callbacks once before freezing. Time resumes from there without catching up
through the capture duration. All tabs in a context share the clock, so their
timers pause together and their captures run one at a time. Network responses,
workers, and media playback are not frozen, so unrelated updates can still
change the page.

### Explicitly, once the page is ready

A capture taken when the URL or the declared conditions change can catch the
page mid-transition. Call `ralph.recordNode` after your assertions to retake
the screenshot of the node just recorded:

```ts
test("cart", { tag: "@ralph" }, async ({ page, ralph }) => {
  await page.goto("https://example.com/cart");
  await expect(page.getByRole("list", { name: "Items" })).toBeVisible();

  await ralph.recordNode(page);
});
```

Pass a `name` to label the node in the graph, e.g.
`ralph.recordNode(page, { name: 'Cart' })`. A later call without one keeps it.

Each call replaces the screenshot, so the last one wins. A dialog at the same
URL is the same node, so recording it would replace the page's screenshot: give
it its own node by declaring a page tag for it (below), since that is what
production events carry.

### Node conditions, for pages that render differently at one URL

When one URL renders differently by visitor (a plan, an experiment group) or by
page state (an open dialog), declare what each screenshot stands for. The test is
the only source of a node's conditions, including sets of values:

```ts
await page.goto("https://example.com/checkout");
const undo = await ralph.setNodeConditions(page, {
  visitorTags: { plan: ["pro", "enterprise"] },
  pageTags: { dialog: [undefined, "shipping"] }, // absent, or shipping
});
await undo();
```

It changes no app state. A declaration that moves the page to a different node
records it again; declarations merge until the URL changes. If your app tags
visitors and pages with `@ralphralphai/tracker`, each recording also checks the
declaration against those tags: where the app reports a value outside it, the node
lists it in `tagMismatches` and the upload page shows it, because those nodes would
match no production traffic. `strictNodeTags` fails the test instead.

### Waiting for capture

Recordings run in the background. If the test leaves a page before its
screenshot is done, the page is `uncaptured`: it's in the graph without a
screenshot. To make sure a page is captured before leaving it:

```ts
await page.goto("https://example.com/pricing");
await ralph.waitForCapture();
await page.goto("https://example.com/signup");
```

### Visiting every link on a page

To record each link of a listing or menu as a step from that page, rather
than from the link visited before it:

```ts
await page.goto("https://example.com/blog");
await ralph.waitForCapture();
await ralph.visitAllLinks(page.locator("a.article:visible"), {
  onVisit: async (article) => {
    await expect(article).toHaveURL(/\/blog\/.+/);
  },
});
```

Each link opens in its own tab, is recorded, and closes before the next one
opens. The edge into each target carries the click. Every match must be a link
(`<a href>`): a button that navigates by script can't open in a new tab, so the
call throws before opening any.

### Pausing capture

To leave steps out of the graph:

```ts
await page.goto("https://example.com/a");
ralph.pause();
await page.goto("https://example.com/b"); // not recorded
await page.goto("https://example.com/c"); // not recorded
ralph.resume();
await page.goto("https://example.com/d"); // recorded, linked from /a
```

This works across tabs. While paused, `recordNode` does nothing. `resume` does
not record the current page.

### Browser contexts you create yourself

```ts
const context = await browser.newContext();
await ralph.observe(context);
// ...
await ralph.waitForCapture();
await context.close();
```

With `freezeDuringCapture`, await `ralph.observe(context)` before creating or
navigating any pages, so no app scripts schedule native timers first. A context
with an already navigated page cannot be enrolled with this option enabled.

### What happened between two nodes

The Playwright actions a test takes on the way from one node to the next are
recorded on the edge between them: clicks, hovers, fills, key presses,
selects, uploads, drags, and `goto` / back / forward / reload. Each one keeps
the element it landed on (its role, name, and `data-track-id`) and where that
element was on the earlier node's screenshot, which Ralph shows as, e.g.,
`Click button "Checkout"`.

What was typed into a password or one-time-code field is never recorded.
Actions taken while recording is paused are left out.

Pass an `edgeLabel` to describe the step in your own words, e.g.
`ralph.recordNode(page, { name: 'Done', edgeLabel: 'Sign in' })`. A later call
without one keeps it.

### When recording fails

- A failed `recordNode` call rejects.
- A failed automatic recording fails the test at the end.
- Pages left before capture, and pages whose layout moved during the
  screenshot, don't fail the test.

## Modes

Set with `RALPH_MODE` or the `mode` option:

| Mode     | What happens                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------ |
| `off`    | Default. Nothing is recorded, and no config or credentials are needed.                                 |
| `upload` | `@ralph` tests are recorded, and the reporter uploads the run. Default when `RALPH_UPLOAD_KEY` is set. |

Untagged tests are never recorded. In `upload` mode, calling
`ralph.recordNode`, `ralph.setNodeConditions`, or `ralph.observe` in an
untagged test throws. Set `ignoreUntaggedCalls` to make them do nothing
instead, for helpers shared between tagged and untagged tests.

## Uploading to Ralph

1. Create an upload key for your project in the project dashboard.
2. Set these as environment variables, or `appId` as
   [reporter options](#reporter-options):

   | Variable           | Value                             |
   | ------------------ | --------------------------------- |
   | `RALPH_UPLOAD_KEY` | The upload key. Environment only. |
   | `RALPH_APP_ID`     | The app the recordings belong to. |

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

### Deployments

When you deploy, upload the run as the graph of the deployed build. Ralph then
matches tracker events from that build to it.

Set `RALPH_DEPLOY=1` and `RALPH_BUILD_ID` to the build's id, usually the commit
SHA:

```sh
RALPH_MODE=upload RALPH_DEPLOY=1 RALPH_BUILD_ID="$COMMIT_SHA" \
  RALPH_UPLOAD_KEY=… RALPH_APP_ID=… pnpm exec playwright test
```

If the build goes live before the test run finishes, register it first so the
tracker picks up its config right away:

```sh
curl --fail-with-body -X POST https://api.ralphralph.ai/api/upload/deployment/register \
  -H "Authorization: Bearer $RALPH_UPLOAD_KEY" -H 'content-type: application/json' \
  -d "{\"externalAppId\":\"$RALPH_APP_ID\",\"buildId\":\"$COMMIT_SHA\",
       \"reserveArtifact\":false,\"config\":$(cat ralph.json)}"
```

`ralph.json` here is your `ralph.jsonc` as plain JSON, without comments or
trailing commas. The test run that follows registers the same build again and
uploads into it.

## Screen sizes

Use `ralphProjects` to create one project per entry in `screenSizes`:

```ts
import { defineConfig, devices } from "@playwright/test";
import { ralphProjects, type RalphFixtures } from "@ralphralphai/playwright";

export default defineConfig<RalphFixtures>({
  projects: [
    {
      name: "chromium",
      grepInvert: /@ralph\b/,
      use: devices["Desktop Chrome"],
    },
    // Creates "chromium 375x812", "chromium 1280x720", …
    ...ralphProjects({
      name: "chromium",
      grep: /@ralph\b/,
      use: devices["Desktop Chrome"],
    }),
  ],
});
```

`ralphProjects` reads `ralph.jsonc` from the current directory. Otherwise pass
`{ root: import.meta.dirname }` or an inline `config` as the second argument.

A test runs at every size. To run it only at some sizes, tag it or its
`describe` block with `@ralph-screen:WIDTHxHEIGHT`, once per size:

```ts
test(
  "mobile navigation",
  { tag: ["@ralph", "@ralph-screen:375x812"] },
  async ({ page }) => {
    await page.getByRole("button", { name: "Menu" }).click();
  },
);

test.describe("desktop layouts", { tag: "@ralph-screen:1280x720" }, () => {
  test("sidebar", { tag: "@ralph" }, async ({ page }) => {});
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

| Option                | Default                  | What it does                                                                                         |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `mode`                | `RALPH_MODE`, else `off` | `off` or `upload`. See [Modes](#modes).                                                              |
| `configPath`          | `ralph.jsonc`            | Path to the config, relative to the Playwright config.                                               |
| `config`              |                          | An inline config instead of a file (type: `WebRalphConfig`).                                         |
| `buildId`             | `RALPH_BUILD_ID`         | Your app's build, to line up recordings with its analytics.                                          |
| `runId`               | `RALPH_RUN_ID`           | Identifies the CI run.                                                                               |
| `settleMs`            | 150                      | Wait after the DOM loads before an automatic recording.                                              |
| `recordTimeoutMs`     | 5000                     | Budget for one recording, including `settleMs` and `ready`. Must exceed `settleMs`.                  |
| `ready`               |                          | `(page, signal) => Promise<void>`. Waits for your app before an automatic recording. Honor `signal`. |
| `reduceMotion`        | `false`                  | Emulates `prefers-reduced-motion: reduce` and waits for finite animations before recording.          |
| `freezeDuringCapture` | `false`                  | Finishes finite browser animations, allows JS-driven DOM changes to settle within a bounded wait, then freezes timers and animations across capture. |
| `strictNodeTags`      | `false`                  | Fails the test when the app reports a tag outside what `ralph.setNodeConditions` declared.           |
| `ignoreUntaggedCalls` | `false`                  | Makes `recordNode`, `setNodeConditions`, and `observe` no-ops in untagged tests instead of throwing. |

## Reporter options

```ts
reporter: [['list'], ['@ralphralphai/playwright/reporter', { appId: 'my-app' }]],
```

| Option            | Default                                           | What it does                                                     |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| `mode`            | `RALPH_MODE`, else `upload` if `RALPH_UPLOAD_KEY` | `upload` uploads the run.                                        |
| `appId`           | `RALPH_APP_ID`                                    | The app the recordings belong to.                                |
| `uploadTimeoutMs` | 120000                                            | Upload timeout.                                                  |
| `deploy`          | `RALPH_DEPLOY` is `1`                             | Uploads the run as its build's. See [Deployments](#deployments). |
| `outputDir`       | `ralph/` in the first project's output directory  | Where the merged graph is written.                               |

The run is also uploaded when any test ran in `upload` mode.

## Limits

Per run: 5,000 screenshots, 256 MiB of screenshots, 16 MiB of other recorded
data, 256 MiB compressed, 20,000 recorded pages, and 5,000 recorded pages per
test.

## License

Apache-2.0
