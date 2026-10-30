# @ralphralphai/playwright

Turn your Playwright tests into a map of your app for
[Ralph](https://ralphralph.ai).

Every page an `@ralph`-tagged test visits becomes a **node** in a graph: a
full-page screenshot, the URL, and the position of every element with a
`data-track-id`. The actions the test takes between two pages (clicks, fills,
navigation) become the **edge** between them. Ralph matches your production
tracker events against this graph.

Untagged tests are untouched, and recording is off unless you turn it on.

## Install

Requires Node.js 20.19+ and Playwright Test 1.63+.

```sh
pnpm add -D @ralphralphai/playwright @playwright/test
pnpm exec playwright install chromium
```

**IMPORTANT** It is currently only tested on chromium. The Firefox support will
be added soon.

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

**2. Tag your elements** with `data-track-id`, using the same ids as your
[`@ralphralphai/tracker`](https://www.npmjs.com/package/@ralphralphai/tracker)
setup:

```html
<button data-track-id="add-to-cart">Add to cart</button>
```

**3. Import `test` from this package and tag tests with `@ralph`:**

```ts
import { test, expect } from "@ralphralphai/playwright";

test("checkout", { tag: "@ralph" }, async ({ page }) => {
  await page.goto("https://example.com/cart");
  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/checkout/);
});
```

**4. Add the Ralph reporter** in `playwright.config.ts`:

```ts
export default defineConfig({
  reporter: [["list"], ["@ralphralphai/playwright/reporter"]],
});
```

**5. Run with an upload key.** Create one in the project dashboard, then:

```sh
RALPH_UPLOAD_KEY=… RALPH_APP_ID=… pnpm exec playwright test
```

This runs in `upload` mode, the default whenever `RALPH_UPLOAD_KEY` is set. The
reporter sends the recorded run to Ralph, which builds the graph from it. An
upload is a preview: it isn't tied to any release, so production tracker
events aren't matched against it. Use it to check the graph while you write
tests, then [deploy](#deploying-a-release) once it looks right.

The reporter prints a link before the upload starts. Open it to watch the run
upload, get processed, and then browse the graph:

```
Ralph: uploading the run. Follow the upload and processing at https://dash.ralphralph.ai/uploads/0f6c6a2e-…
Ralph: uploaded the run. Ralph is processing it at https://dash.ralphralph.ai/uploads/0f6c6a2e-…
```

`RALPH_UPLOAD_KEY` must be an environment variable. `RALPH_APP_ID` can be
set as the reporter's `appId` option.

## Deploying a release

Once the previewed graph looks right, upload it as the graph of the build you
deploy. Ralph then matches that build's tracker events to it. Set
`RALPH_MODE=deploy` and `RALPH_BUILD_ID`, usually the commit SHA:

```sh
RALPH_MODE=deploy RALPH_BUILD_ID="$COMMIT_SHA" \
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

`ralph.json` is your `ralph.jsonc` as plain JSON, without comments or trailing
commas. The test run that follows registers the same build again and uploads
into it.

## Diffing deployments

Along with the screenshot, each node records an ARIA snapshot of the page: the
accessibility tree, each element's box, its distinctive styles (fonts, colors,
spacing, borders), and a hash of each image. Ralph diffs a node's snapshot
against the same node in the previous deployment to show what changed.

Hidden elements, elements clipped by an ancestor's overflow, and tiny iframes
such as tracking pixels are left out, so they never show up as changes.

Two tools keep content that changes on its own from showing up as a change:

- **`data-ralph-dynamic`** marks a subtree whose content the server generates
  on every request, such as a blog listing or a price quote. The diff compares
  only its structure and styles, not its text, links, or images:

  ```html
  <div>
    <article>
      <p data-ralph-dynamic>Posted 3 days ago</p>
    </article>
  </div>
  ```

- **`ignoreInDiff`** removes a subtree from the snapshot entirely, for parts
  that aren't yours to diff, such as ads, chat widgets, or live counters.
  Matched elements still appear in the screenshot:

  ```ts
  ralphOptions: {
    ignoreInDiff: ['.ad-slot', '#intercom-container', 'live-clock'],
  },
  ```

Use `data-ralph-dynamic` when you still want layout and style changes in that
area reported, and `ignoreInDiff` when you don't.

## How recording works

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

Recordings run in the background. A page the test leaves before its screenshot
is done stays in the graph as `uncaptured`, with no screenshot. See
[`waitForCapture`](#waiting-for-capture).

Each action between two nodes is stored on the edge with the element it landed
on (role, name, `data-track-id`) and where that element was on the earlier
screenshot. Ralph shows it as, e.g., `Click button "Checkout"`. Recorded
actions are clicks, hovers, fills, key presses, selects, uploads, drags, and
`goto` / back / forward / reload. Text typed into password or one-time-code
fields is never recorded.

## Test API

The `ralph` fixture controls recording from inside a test.

### Recording once the page is ready

An automatic capture can catch the page mid-transition. Call `ralph.recordNode`
after your assertions to retake the screenshot of the current node:

```ts
test("cart", { tag: "@ralph" }, async ({ page, ralph }) => {
  await page.goto("https://example.com/cart");
  await expect(page.getByRole("list", { name: "Items" })).toBeVisible();

  await ralph.recordNode(page);
});
```

Each call replaces the screenshot, so the last one wins. Options:

- `name` labels the node in the graph: `ralph.recordNode(page, { name: 'Cart' })`.
- `edgeLabel` describes the step into it in your own words:
  `ralph.recordNode(page, { name: 'Done', edgeLabel: 'Sign in' })`.

A later call without either one keeps the earlier value.

### One URL, several renderings

When one URL renders differently by visitor (a plan, an experiment group) or by
page state (an open dialog), declare what each screenshot stands for:

```ts
await page.goto("https://example.com/checkout");
const undo = await ralph.setNodeConditions(page, {
  visitorTags: { plan: ["pro", "enterprise"] },
  pageTags: { dialog: [undefined, "shipping"] }, // absent, or shipping
});
await undo();
```

This changes no app state. A declaration that moves the page to a different
node records it again, and declarations merge until the URL changes. A dialog
at the same URL is the same node unless you give it a page tag like this.

### Waiting for capture

To make sure a page is captured before leaving it:

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
opens. Every match must be an `<a href>`, or the call throws before opening any.

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

This works across tabs. While paused, `recordNode` does nothing and actions are
left off the edge. `resume` does not record the current page.

### Browser contexts you create yourself

```ts
const context = await browser.newContext();
await ralph.observe(context);
// ...
await ralph.waitForCapture();
await context.close();
```

## Stable captures

For apps with animations or live content:

- `reduceMotion: true` emulates `prefers-reduced-motion: reduce`. CSS
  animations and transitions are always frozen for the screenshot.
- `freezeDuringCapture: true` lets the page settle, then freezes timers and
  animations so the screenshot, element positions, and ARIA snapshot match.
  See [Troubleshooting](#freezeduringcapture-in-detail) before enabling it.
- `data-ralph-dynamic` and `ignoreInDiff` keep content that changes on its own
  out of the diff. See [Diffing deployments](#diffing-deployments).

## Modes

Set with `RALPH_MODE` or the `mode` option:

| Mode     | What happens                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`    | Default. Nothing is recorded, and no config or credentials are needed.                                                                          |
| `upload` | `@ralph` tests are recorded, and the reporter uploads the run as a preview graph not tied to a release. Default when `RALPH_UPLOAD_KEY` is set. |
| `deploy` | Like `upload`, but the run is uploaded as its build's graph. See [Deploying a release](#deploying-a-release).                                   |

The reporter uploads the run when any test ran in `upload` or `deploy` mode,
and as its build's graph when any ran in `deploy` mode.

Untagged tests are never recorded. In `upload` and `deploy` modes, calling
`ralph.recordNode`, `ralph.setNodeConditions`, or `ralph.observe` in an
untagged test throws. Set `ignoreUntaggedCalls` to make them do nothing
instead, for helpers shared between tagged and untagged tests.

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

A size missing from `screenSizes` fails the test. To run one size:
`playwright test --project "chromium 375x812"`.

## Sharded runs

Use the `blob` reporter on each shard, then merge with the Ralph reporter:

```sh
# Each shard (no upload credentials needed):
RALPH_MODE=upload pnpm exec playwright test --shard=1/4 --reporter blob

# Once, after collecting every shard's blob-report/ into all-blob-reports/:
RALPH_MODE=upload RALPH_UPLOAD_KEY=… RALPH_APP_ID=… \
  pnpm exec playwright merge-reports --reporter @ralphralphai/playwright/reporter ./all-blob-reports
```

## Options

Set `ralphOptions` in `playwright.config.ts`, or per file with `test.use`:

```ts
export default defineConfig<RalphFixtures>({
  use: {
    ralphOptions: { buildId: process.env.GIT_SHA, settleMs: 300 },
  },
});
```

| Option                | Default                  | What it does                                                                                                                    |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                | `RALPH_MODE`, else `off` | `off`, `upload`, or `deploy`. See [Modes](#modes).                                                                              |
| `configPath`          | `ralph.jsonc`            | Path to the config, relative to the Playwright config.                                                                          |
| `config`              |                          | An inline config instead of a file (type: `WebRalphConfig`).                                                                    |
| `buildId`             | `RALPH_BUILD_ID`         | Your app's build, to line up recordings with its analytics.                                                                     |
| `runId`               | `RALPH_RUN_ID`           | Identifies the CI run.                                                                                                          |
| `settleMs`            | 150                      | Wait after the DOM loads before an automatic recording.                                                                         |
| `recordTimeoutMs`     | 5000                     | Budget for one recording, including `settleMs` and `ready`. Must exceed `settleMs`.                                             |
| `ready`               |                          | `(page, signal) => Promise<void>`. Waits for your app before an automatic recording. Honor `signal`.                            |
| `reduceMotion`        | `false`                  | Emulates `prefers-reduced-motion: reduce` and waits for finite animations before recording.                                     |
| `freezeDuringCapture` | `false`                  | Lets the page settle, then freezes timers and animations across capture. See [Troubleshooting](#freezeduringcapture-in-detail). |
| `ignoreInDiff`        |                          | CSS selectors for subtrees to omit from the ARIA snapshot.                                                                      |
| `strictNodeTags`      | `false`                  | Fails the test when the app reports a tag outside what `ralph.setNodeConditions` declared.                                      |
| `ignoreUntaggedCalls` | `false`                  | Makes `recordNode`, `setNodeConditions`, and `observe` no-ops in untagged tests instead of throwing.                            |

### Reporter options

```ts
reporter: [['list'], ['@ralphralphai/playwright/reporter', { appId: 'my-app' }]],
```

| Option            | Default                                           | What it does                                                  |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `mode`            | `RALPH_MODE`, else `upload` if `RALPH_UPLOAD_KEY` | `upload` uploads the run. `deploy` uploads it as its build's. |
| `appId`           | `RALPH_APP_ID`                                    | The app the recordings belong to.                             |
| `uploadTimeoutMs` | 120000                                            | Upload timeout.                                               |
| `outputDir`       | `ralph/` in the first project's output directory  | Where the merged graph is written.                            |

## Troubleshooting

### A test failed because of recording

- A failed `recordNode` call rejects.
- A failed automatic recording fails the test at the end.
- Pages left before capture, and pages whose layout moved during the
  screenshot, don't fail the test.

### A page has no screenshot

The test left the page before capture finished, so it's `uncaptured`. Call
`ralph.waitForCapture()` before navigating away.

### Part of a very large page is missing

Screenshots are WebP, which holds at most 16,383 px per side. A taller or wider
page is recorded up to that size, and what lies beyond it has no screenshot.

### A dialog replaced the page's screenshot

A dialog at the same URL is the same node. Give it its own node with a page tag
via `ralph.setNodeConditions` (see
[One URL, several renderings](#one-url-several-renderings)), since that is what
production events carry.

### The upload page shows `tagMismatches`

If your app tags visitors and pages with `@ralphralphai/tracker`, each
recording checks the declared node conditions against those tags. Where the app
reports a value outside the declaration, the node lists it in `tagMismatches`,
because that node would match no production traffic. Fix the declaration, or set
`strictNodeTags` to fail the test instead.

### `visitAllLinks` throws

Every match must be a link (`<a href>`). A button that navigates by script
can't open in a new tab, so the call throws before opening any.

### An ignored element's text still shows in the diff

`ignoreInDiff` removes matched elements and their descendants, including
content in open shadow roots and slots. Text that sits inline in a larger
element, like a bare `<span>` in a paragraph, belongs to that element's text
and is not removed. Wrap it in an element with a role, or match the whole
paragraph. The space ignored elements take up still moves the elements around
them.

### `freezeDuringCapture` in detail

Ralph installs Playwright's clock before the app loads. Before capture it
finishes running finite CSS transitions, CSS animations, and Web Animations,
and watches DOM changes in the page, its frames, and open shadow roots. Timers
and animation frames keep running until the DOM has been quiet for 150 ms, so
JavaScript-driven animations can finish without changes to your app.
Animations started by completion callbacks are checked again.

This settling wait is capped at 1.5 seconds or half the remaining
`recordTimeoutMs` budget, whichever is smaller. Looping browser animations are
paused while settling. Then timers and all remaining browser animations pause
during capture and resume afterward, including on failure. Animations the app
already paused stay paused, and finished animations stay finished.

Limits:

- The quiet check is a heuristic. Long JavaScript animations can be captured
  midway when the budget runs out, and future delayed work and canvas or WebGL
  drawing aren't detected.
- The clock replaces native timer APIs for the lifetime of the context, so
  don't combine it with manual `page.clock` or `context.clock` control.
- Playwright requires a future pause time. Ralph uses the page's current time
  plus 100 ms, which advances the clock and can fire due callbacks once before
  freezing. Time resumes from there without catching up through the capture.
- All tabs in a context share the clock, so their timers pause together and
  their captures run one at a time.
- Network responses, workers, and media playback are not frozen.
- With contexts you create yourself, await `ralph.observe(context)` before
  creating or navigating any pages. A context with an already navigated page
  can't be enrolled with this option on.

## Limits

Per run: 5,000 screenshots, 256 MiB of screenshots, 16 MiB of other recorded
data, 256 MiB compressed, 20,000 recorded pages, and 5,000 recorded pages per
test.

Per page: an ARIA snapshot over 4 MiB or nested deeper than the server
allows is left out. The page still uploads, but it can't be diffed.

## License

Apache-2.0
