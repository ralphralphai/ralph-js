# @ralphralphai/playwright: implementation notes

For people working on this package. The user-facing docs are in
[README.md](README.md). This file isn't published to npm.

## The model

The package records **raw nodes**. The server builds the graph.

- A raw node is one page state as the test saw it: URL, screenshot,
  tracked-element geometry, and `previousNodeId`, the node it was reached from.
- The client doesn't normalize or merge anything. The same page visited twice
  gives two raw nodes, and superseded and failed recordings are kept.
- The server normalizes URLs, applies `variantRules` and `hostOverrides` from
  the config snapshot, merges raw nodes into graph nodes, and turns
  `previousNodeId` links into edges.

Nothing is injected into the page under test. The flow comes only from the
order of URL changes (plus tab openers). An earlier version used an in-page
click listener to label edges with the clicked element. It was dropped: it put
code in the app under test, and attribution by timing was unreliable.

## Source layout

| File                                   | What                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`src/index.ts`](src/index.ts)         | Public exports and the extended `test`: the Playwright fixtures that wire the recorder in.                  |
| [`src/recorder.ts`](src/recorder.ts)   | `Recorder`: watches tabs, queues and takes recordings, links nodes, writes and uploads the manifest.        |
| [`src/layout.ts`](src/layout.ts)       | Reads viewport, document size, scroll, device pixel ratio, and `data-track-id` boxes from the page.         |
| [`src/image.ts`](src/image.ts)         | Full-page screenshot as WebP with a PNG fallback; reads image dimensions from the headers.                  |
| [`src/upload.ts`](src/upload.ts)       | Builds the `.tar.gz` bundle and POSTs it; resolves upload options.                                          |
| [`src/config.ts`](src/config.ts)       | Resolves the mode; loads and validates `ralph.jsonc` into a `ConfigSnapshot`.                               |
| [`src/screens.ts`](src/screens.ts)     | `ralphProjects` and `@ralph-screen:` tag selection.                                                         |
| [`src/types.ts`](src/types.ts)         | Public types, including the manifest format.                                                                |

## Fixtures

`src/index.ts` extends Playwright's `test` with these fixtures. Playwright works
out each fixture's dependencies by parsing the destructured first parameter of
its function, which is why fixtures with no dependencies still write `{}`.

| Fixture          | Scope  | Auto | Role                                                                                                                  |
| ---------------- | ------ | ---- | --------------------------------------------------------------------------------------------------------------------- |
| `ralphOptions`   | test   |      | The user's options.                                                                                                   |
| `_ralphConfigs`  | worker |      | Caches the config load per source, so each worker validates `ralph.jsonc` once.                                         |
| `_ralphScreen`   | test   | yes  | Applies `@ralph-screen:` tags; may skip the test. Runs in every mode.                                                  |
| `_ralphRecorder` | test   | yes  | Creates a `Recorder` for `@ralph` tests when the mode isn't `off`; `finish()`es it in teardown. 30 s teardown budget for the upload. |
| `ralph`          | test   |      | What tests receive: the recorder, or a stand-in that is a no-op in `off` mode and throws "add the @ralph tag" otherwise. |
| `context`        | test   |      | Override of Playwright's: `observe()`s the context before the test and `stopContext()`s it after.                      |

Notes:

- `_ralphRecorder` is `auto` so recording happens even in tests that never ask
  for `ralph`. The `context` override is what starts watching; any test using
  `page` pulls it in through `page → context`.
- `_ralphRecorder` lists `_ralphScreen` as a dependency without using it. That
  forces screen selection to run first, so a skipped test never builds a
  recorder or writes a manifest.
- `stopContext` runs in the `context` teardown because Playwright's base
  `context` fixture closes its pages right after; pending recordings still need
  them open.

## Recorder

### Per-tab state

Each tab (`Page`) gets a `PageState`, keyed by the `Page` object. Playwright
hands out one `Page` instance per tab everywhere (`context.pages()`, the `page`
event, `page.opener()`, fixtures), so identity lookups work.

- `lastUrl`: the last navigated URL. A navigation to the same URL (a reload) is
  not recorded.
- `generation`: bumped on every main-frame navigation, reloads included. A
  recording that finishes under a different generation was overtaken.
- `sequence`: the next node's position within the tab.
- `tail`: the last queued recording. Recordings in one tab run one at a time;
  tabs run in parallel.
- `opener`: a promise that resolves once `info.openerPageId` is filled in from
  `page.opener()`. It is not the opener itself.

### One recording

`enqueue` builds the request (id, sequence, requested time, actual and recorded
URL, trigger, optional state) and chains `record` onto the tab's `tail`.

`record`:

1. Starts a deadline of `recordTimeoutMs`. `wait()` races each step against it.
2. For automatic (`url-change`) recordings only: waits for `domcontentloaded`,
   then `settleMs`, then the `ready` hook.
3. Reads the layout, takes the screenshot, and reads the layout again.
4. Before and after every step, checks the tab hasn't navigated (generation or
   URL changed) or closed.
5. On success, writes the screenshot and pushes a `captured` node.
   `geometryStable` is whether the two layout reads match.
6. On failure, pushes a `superseded` node if the tab navigated away, otherwise
   `failed`, with the error message. Explicit recordings rethrow; automatic
   ones don't, and `finish` fails the test instead.

### Linking nodes

`linkPreviousNodes` runs in `finish`, once every recording has settled and
every opener is known:

1. The raw chain: each node's predecessor is the previous node in its tab. A
   popup's first node gets its opener tab's last node requested before it
   (compared by `requestedAtMs`, so later navigations in the opener don't
   count).
2. Superseded predecessors are skipped, so `/start → /a (replaced) → /b`
   records `/b ← /start`.

### Layout

- Only elements Playwright considers visible (`filter({ visible: true })`), in
  the main frame, including open shadow roots.
- Boxes are in document CSS pixels: the bounding rect plus the scroll offset.
- Elements with zero width or height, or entirely off-screen horizontally, are
  dropped, as the DFS crawler does. Elements below the fold are kept, because
  the screenshot is full-page.
- Duplicate track ids are kept as separate boxes.

### Screenshots

Full-page, `scale: 'css'` (one image pixel per CSS pixel on high-DPI devices),
WebP at quality 80 to match the crawler. WebP can't encode more than 16,383 px
in either dimension, and Chromium signals that with an empty buffer rather than
an error, so an empty result falls back to PNG. Dimensions are parsed from the
image headers (`VP8 `, `VP8L`, `VP8X` for WebP; `IHDR` for PNG).

## Manifest

`RawGraphManifest` in [`src/types.ts`](src/types.ts), `formatVersion: 1`.

- `producer`, `runId`, `buildId`, `attemptId`, and `test` identify where it came
  from. `attemptId` is new for every recorder, so retries are distinct.
- `config` is the `ConfigSnapshot`: the parsed config without schema defaults
  applied, plus the `@ralphralphai/config` version.
- `pages` lists every tab: `pageId`, `contextId`, `browserName`,
  `openerPageId`.
- `nodes` is sorted by page, then sequence.
- `test.status` is `failed` when the test passed but a recording failed, since
  `finish` fails the test after the manifest is written.
- `complete` is true only when the test passed, there's at least one node, and
  every node was captured with stable geometry. Another fixture failing later
  isn't reflected; a reporter would have to reconcile that.

## Upload

`POST {apiUrl}/api/upload/playwright/apps/{appId}/attempts` with
`Authorization: Bearer <uploadKey>` and an `application/gzip` body:

```
raw_graph.json               { manifest, screenshots: [{ nodeId, path }] }
assets/images/<nodeId>.webp  (or .png)
```

- The tar entries have fixed `mtime`, `uid`, and `gid`, so the same attempt
  always produces the same bytes. The server relies on this: an identical
  re-upload returns `replayed: true` with the original `resultId`, and
  different contents under the same `attemptId` are rejected.
- `nodeId` and `appId` are validated as path-safe before use.
- `apiUrl` must be `https:`, or `http:` for loopback hosts only.
- `redirect: 'error'`, so the key is never sent to a redirect target.
- The receipt must echo the `attemptId` and include a `resultId`, or the upload
  is treated as failed.
- Limits: 2 MiB manifest JSON, 500 screenshots, 64 MiB of screenshots, 64 MiB
  compressed. The server also caps nodes at 5,000.
- No automatic HTTP retries.

`uploadRawGraph(manifest, screenshots, { apiUrl, appId, uploadKey, timeoutMs? })`
and `createRawGraphBundle(manifest, screenshots)` are exported so a saved result
can be uploaded again, e.g. from a later CI step. `screenshots` is one
`{ nodeId, contentType, bytes }` per captured node, read from the files the
manifest references. They are internal tooling and deliberately not documented
in the README.

The server keeps its own versioned schemas and picks one by `formatVersion`.
This package imports no server code.

## Server contract checklist

When changing the manifest or bundle, the server needs matching changes:

- field renames or removals within `formatVersion: 1` (only while unreleased;
  otherwise bump the version)
- new image content types
- bundle layout or file names

## Development

From the repository root:

```sh
pnpm --filter @ralphralphai/config build   # the playwright package reads config's dist
pnpm --filter @ralphralphai/playwright build
pnpm --filter @ralphralphai/playwright check
pnpm --filter @ralphralphai/playwright lint
pnpm --filter @ralphralphai/playwright test
pnpm --filter @ralphralphai/playwright exec playwright install chromium
pnpm --filter @ralphralphai/playwright test:browser
```

- `test` runs unit tests under `src/`.
- `test:browser` builds first, then runs real Playwright suites
  (`test/scenarios.spec.ts`, `test/screens.spec.ts`) against locally served
  pages, and checks the emitted manifests, screenshots, and uploads from
  `test/browser.test.ts` and `test/screens.test.ts`. The scenarios import from
  `dist/`, so rebuild after changing `src/`.
- The suite includes a deliberately failing first attempt, to check that retries
  get separate manifests.
- After changing `@ralphralphai/config`'s schema, rebuild it before running
  these tests, or they validate against the old one.
