# @ralphralphai/playwright

Opt-in Playwright fixtures for recording the page states a test visits. Ralph
automatically captures URL changes, and explicit captures handle dialogs and
other states at the same URL. Each capture contains a screenshot, the recorded
and actual URLs, and `data-track-id` element positions.

The fixture saves local artifacts and can upload a gzip-compressed tar bundle per
test attempt. Graph construction runs on the server; ingestion currently returns
an attempt receipt, with graph processing and the dashboard URL still pending.

## Install and enable

Requires Node.js 20.19+ and Playwright Test 1.62.1+ within major version 1.

```sh
pnpm add -D @ralphralphai/playwright @playwright/test
pnpm exec playwright install chromium
```

Put a `ralph.jsonc` next to `playwright.config.ts`:

```json
{
  "screenSizes": []
}
```

The actual viewport is controlled by Playwright; use `ralphProjects` to run
tests at the config's `screenSizes` (see [Screen sizes](#screen-sizes)). The
fixture preserves the Ralph config; it does not run its simple URL crawls.

Use Ralph's extended `test` and tag the tests that should participate:

```ts
import { test, expect } from '@ralphralphai/playwright';

test('checkout', { tag: '@ralph' }, async ({ page, ralph }) => {
  await page.goto('https://example.com/cart');
  await ralph.flush();

  await page.getByRole('button', { name: 'Shipping options' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await ralph.captureNode(page, {
    state: 'shipping-options-open',
    url: '/checkout/shipping-options',
  });
});

test('ordinary validation', async ({ page }) => {
  await page.goto('https://example.com/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
```

```sh
RALPH_MODE=local pnpm exec playwright test
```

Recording defaults to off. Normal `pnpm exec playwright test` runs need no
Ralph config or credentials. Unmarked tests stay unrecorded in every mode.
Calling `ralph.capture` in an unmarked test while recording is enabled reports
the missing `@ralph` tag.

`RALPH_MODE=off` disables recording and makes explicit capture calls no-ops.
Tests that import directly from `@playwright/test` continue to work alongside
Ralph tests. Importing the integration does not launch a browser for API-only
tests.

`RALPH_MODE=upload`, or setting `RALPH_UPLOAD_KEY` without an explicit mode,
enables uploading. Set `RALPH_API_URL` to your Ralph server origin (or set
`ralphOptions.apiUrl`). The origin must use HTTPS; plain HTTP is accepted only
for loopback hosts (`localhost`, `127.x.x.x`, `[::1]`) during local development.
Issue a private upload key for your Ralph project with the authenticated
`/api/project/playwright/key/create` endpoint and keep it in CI secrets. A key belongs to
the project, so one key serves every app in it. Set `RALPH_APP_ID` (or
`ralphOptions.appId`) to the app the captures belong to.

```sh
RALPH_MODE=upload RALPH_API_URL=https://your-ralph-server.example RALPH_APP_ID=<app id> pnpm exec playwright test
```

This uses `RALPH_UPLOAD_KEY` from the environment. Each opted-in attempt uploads
once during fixture teardown, after its local manifest and screenshots are saved.
No reporter configuration is required. `off`, `local`, and unmarked tests do not
upload, even if CI provides a key. Upload failures fail fixture teardown and leave
local artifacts available according to Playwright's `preserveOutput` setting.
Successful uploads attach a `ralph-upload-receipt`; credentials are never written
to the manifest or receipt.

## Capture behavior

Automatic capture watches main-frame HTTP(S) URLs in the standard `context`
fixture, including new tabs and popups. It includes the first application URL,
full-document navigation, SPA history changes, query changes, and hash changes.
It skips `about:blank`, subframe navigation, same-URL reloads, and DOM-only changes.

Automatic captures wait for DOM content loaded and then settle for 150 ms by
default. A URL change does not prove application readiness. Supply `ready` for
an application-specific condition, or explicitly capture after your assertions.

Capture runs in the background and is serialized per browser page. A test can
navigate again before a screenshot completes. Such nodes are retained as
`superseded`, without a screenshot attributed to the wrong URL. Use
`await ralph.flush()` to wait for currently queued captures before deliberately
leaving a state whose screenshot you need. This is also useful before manually
closing a page or context.

The standard context fixture drains captures before closing its pages. Manually
created contexts can be enrolled with `ralph.observe(context)`; their owner must
flush before closing them. An explicit capture enrolls its page's context too.

`await ralph.captureNode(page, { state?, url? })` always requests a node,
even at the same URL. It uses the current state without the automatic settling
delay or readiness hook. A relative URL override resolves against the actual
browser URL. It does not navigate, change history, or affect subsequent automatic
captures. Only HTTP(S) recorded URLs are accepted.

Explicit capture errors reject the call. Automatic capture errors are written
to the manifest and fail an otherwise passing opted-in test at fixture teardown.
Superseded captures and detected geometry changes mark the manifest incomplete,
without independently failing the test.

## Screen sizes

A viewport is fixed for a browser context, and a mobile flow is usually a
different test from its desktop flow. So each `screenSizes` entry becomes its
own Playwright project. `ralphProjects` reads the Ralph config synchronously
and expands a base project into one project per size. Each project's viewport
is that size:

```ts
import { defineConfig, devices } from '@playwright/test';
import { ralphProjects, type RalphFixtures } from '@ralphralphai/playwright';

export default defineConfig<RalphFixtures>({
  projects: [
    // Ordinary tests keep their single project.
    { name: 'chromium', grepInvert: /@ralph\b/, use: devices['Desktop Chrome'] },
    // With screenSizes 375x812, 768x1024 and 1280x720, this yields the projects
    // "chromium 375x812", "chromium 768x1024" and "chromium 1280x720".
    ...ralphProjects({
      name: 'chromium',
      grep: /@ralph\b/,
      use: devices['Desktop Chrome'],
    }),
  ],
});
```

A relative `configPath` resolves against the current directory. Pass
`{ root: import.meta.dirname }` (or `__dirname`) or an inline `config` as the
second argument when Playwright runs from elsewhere. Keep it pointing at the
same config as `ralphOptions`.

By default, a test runs at every screen size. Tag a test or a `describe` block
with `@ralph-screen:WIDTHxHEIGHT`, once per size, to run it only at the listed
sizes. Tags on a `describe` block and its tests combine. The other
screen projects skip it:

```ts
test(
  'mobile navigation',
  { tag: ['@ralph', '@ralph-screen:375x812'] },
  async ({ page }) => {
    await page.getByRole('button', { name: 'Menu' }).click();
  },
);

// One tag per size: runs at 768x1024 and 1280x720, skipped at 375x812.
test(
  'data table',
  { tag: ['@ralph', '@ralph-screen:768x1024', '@ralph-screen:1280x720'] },
  async ({ page }) => {},
);

test.describe('desktop layouts', { tag: '@ralph-screen:1280x720' }, () => {
  test('sidebar', { tag: '@ralph' }, async ({ page }) => {});
});
```

Screen tags apply in every mode, including `off`, and to untagged tests, because
they choose which flows run. A size the config does not declare fails the test,
so typos don't silently skip it. Projects not created by `ralphProjects` ignore
screen tags. To run one size from the command line, use Playwright's project
filter: `playwright test --project "chromium 375x812"`.

## Options

`WebRalphConfig` is re-exported as a type from this package for inline config
annotations. Its definition remains in `@ralphralphai/config`:

```ts
import type { WebRalphConfig } from '@ralphralphai/playwright';

const config: WebRalphConfig = { screenSizes: [] };
```

Set `ralphOptions` with `test.use` or Playwright's configuration:

```ts
import { defineConfig } from '@playwright/test';
import type { RalphFixtures } from '@ralphralphai/playwright';

export default defineConfig<RalphFixtures>({
  use: {
    viewport: { width: 1280, height: 720 },
    ralphOptions: {
      mode: 'local',
      configPath: './ralph.jsonc',
      buildId: 'application-build-id',
      runId: 'ci-run-id',
      settleMs: 150,
      captureTimeoutMs: 5000,
      ready: async (page, signal) => {
        signal.throwIfAborted();
        await page.getByTestId('app-ready').waitFor({ timeout: 3000 });
      },
    },
  },
});
```

| Option | Behavior |
| --- | --- |
| `mode` | `off`, `local`, or `upload`; overrides `RALPH_MODE` |
| `apiUrl` | Server origin for uploads; falls back to `RALPH_API_URL` |
| `uploadTimeoutMs` | Upload request deadline; defaults to 15000 ms |
| `configPath` | Relative to the Playwright config directory; defaults to `ralph.jsonc` |
| `config` | Inline `WebRalphConfig` instead of a config file |
| `buildId` | Optional application build ID; falls back to `RALPH_BUILD_ID` |
| `runId` | Optional shared CI run ID; falls back to `RALPH_RUN_ID` |
| `settleMs` | Automatic settling delay; defaults to 150 ms |
| `captureTimeoutMs` | Per-capture browser-work deadline; defaults to 5000 ms |
| `ready` | Optional automatic-capture readiness callback with an abort signal |

The deadline includes settling and readiness. Custom readiness work should
honor the signal or use its own bounded Playwright operations. Ralph can stop
waiting for a callback but cannot cancel arbitrary user code.

Config files accept JSONC comments and trailing commas and are validated against
the published config schema. The complete parsed values are snapshotted without
injecting schema defaults, along with the config package version.
Snapshots are cached per config source within a worker. Keep the config unchanged
during a run; the server compares configs across workers before combining
attempts. Run/build IDs are optional for local exploration, and unique
attempt IDs are always generated.

## Existing fixtures

Compose Ralph with the test object your project already uses:

```ts
import { mergeTests } from '@playwright/test';
import { test as ralphTest } from '@ralphralphai/playwright';
import { test as applicationTest } from './application-fixtures';

export const test = mergeTests(applicationTest, ralphTest);
```

If a custom fixture replaces the standard context entirely, enroll that context
using `ralph.observe(context)`. Capture it while it is still alive.

## Artifacts

Each opted-in attempt writes `ralph/captures.json` and full-page screenshots within
Playwright's per-test output directory. The JSON is attached as
`ralph-captures`; screenshots are attached with unique names referenced by the
manifest. Copy the full test output or retain the Playwright attachments.
Configure Playwright to preserve successful test output when collecting captures.

The exported `CaptureManifest` and `RawNode` types describe format
version 1. The manifest includes the config snapshot, producer versions, optional run and
build IDs, test/project/retry/repeat/shard identity, separate browser-page streams,
opener relationships, and the `nodes` the test produced.

Each entry in `nodes` is a raw node: one page state as the test saw it, with a
sequence within its page. The same page visited twice produces two raw nodes,
and superseded or failed captures are kept too. The server merges raw nodes
into the graph's nodes; this package does no normalization or merging.

Each node records `previousNodeId`, the node its page state was reached from:
the previous one on the same page, or for a popup's first node, its opener's
latest. Superseded nodes are skipped. No code is injected into
the page; the flow comes from the order of URL changes.

Screenshots are WebP at quality 80, falling back to PNG for pages over 16,383
pixels in either dimension, which WebP cannot encode. They use one image pixel
per CSS pixel, including on high-DPI devices.
Tracked-element boxes use document CSS coordinates and preserve duplicate track
IDs as separate boxes. Collection includes visible elements in the main frame,
including open shadow roots; it does not collect child-frame geometry. Elements
with zero width or height, or entirely off-screen horizontally, are dropped;
elements below the fold are kept.
The manifest records viewport, document extent, scroll position, screenshot size,
and device pixel ratio.

Geometry is measured before and after the screenshot. Differences set
`geometryStable: false`. This detects layout drift, not every visual change;
animations, sticky elements, and virtualized content can still need explicit
application preparation. The package does not freeze or alter the application.

An attempt is `complete` only when the test has passed at fixture finalization,
there is at least one node, and every node has a screenshot with
stable measured geometry. A future reporter must reconcile this with the final
Playwright result if another fixture fails later. Retries have distinct manifests
and attempt IDs; partial nodes are preserved.

## Upload format and retries

The HTTP body is one `application/gzip` tar archive. `capture.json` holds UTF-8
JSON `{ manifest, screenshots: [{ nodeId, path }] }`, and each `path` points to
a raw WebP (or PNG fallback) under `assets/images/`. The manifest includes the exact config
snapshot.
The package emits only its current `formatVersion: 1`; the server independently
keeps versioned Zod schemas and selects one by `formatVersion`. No crawler API
package or server schema is imported by this integration.

The limits per attempt are 64 MiB compressed, 2 MiB manifest JSON, 64 MiB total
screenshot bytes, and 500 screenshots. Server validation
also limits nodes to 5,000. Split larger scenarios into smaller tests.
Screenshots are already compressed; gzip mainly compresses the manifest.

`uploadCapture(manifest, screenshots, { apiUrl, uploadKey, timeoutMs? })` can retry
saved artifacts, where each screenshot is `{ nodeId, contentType, bytes: Uint8Array }`.
`createCaptureBundle(manifest, screenshots)` returns the gzip bytes when a caller
needs to handle transport itself. An identical retry preserves `attemptId` and
returns `replayed: true`; changed contents under the same ID are rejected. There
are no automatic HTTP retries. Playwright test retries create new attempt IDs.
The manifest's status reflects fixture finalization; a future reporter can
reconcile failures in fixtures that finish later.

## Development

From the repository root:

```sh
pnpm --filter @ralphralphai/config build
pnpm --filter @ralphralphai/playwright build
pnpm --filter @ralphralphai/playwright check
pnpm --filter @ralphralphai/playwright lint
pnpm --filter @ralphralphai/playwright test
pnpm --filter @ralphralphai/playwright exec playwright install chromium
pnpm --filter @ralphralphai/playwright test:browser
```

The browser suite runs real Playwright tests against locally supplied pages,
then checks the emitted manifests and screenshot attachments. It includes an
intentional failed first attempt to verify retry isolation.
