# @ralphralphai/playwright: implementation notes

For people working on this package. The user-facing docs are in
[README.md](README.md). This file isn't published to npm.

## The model

The package records **raw nodes**. The server builds the graph.

- A raw node is one page state as the test saw it: URL, screenshot,
  tracked-element geometry, and `previousNodeId`, the node it was reached from.
- The client doesn't normalize or merge anything. The same page visited twice
  gives two raw nodes, and uncaptured ones are kept.
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
| [`src/recorder.ts`](src/recorder.ts)   | `Recorder`: watches tabs, queues and takes recordings, links nodes, writes the test's raw graph.            |
| [`src/reporter.ts`](src/reporter.ts)   | `RalphReporter`: merges every test's raw graph into the run's manifest, writes it, and uploads it once.     |
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
| `_ralphRecorder` | test   | yes  | Creates a `Recorder` for `@ralph` tests when the mode isn't `off`; `finish()`es it in teardown. In `upload` mode, throws unless the reporter is on. |
| `ralph`          | test   |      | What tests receive: the recorder, or a stand-in that is a no-op in `off` mode and throws "add the @ralph tag" otherwise. |
| `context`        | test   |      | Override of Playwright's: `observe()`s the context before the test and `stopContext()`s it after.                      |

Notes:

- `_ralphRecorder` is `auto` so recording happens even in tests that never ask
  for `ralph`. The `context` override is what starts watching; any test using
  `page` pulls it in through `page → context`.
- `_ralphRecorder` lists `_ralphScreen` as a dependency without using it. That
  forces screen selection to run first, so a skipped test never builds a
  recorder or writes a raw graph.
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

`enqueueCreateNodeRequest` builds a `CreateNodeRequest` (id, sequence,
requested time, actual and recorded URL, trigger, optional state) and chains
`createNode` onto the tab's `tail`.

`createNode`:

1. Starts a deadline of `recordTimeoutMs`. `wait()` races each step against it.
2. For automatic (`url-change`) recordings only: waits for `domcontentloaded`,
   then `settleMs`, then the `ready` hook.
3. Reads the layout, takes the screenshot, and reads the layout again.
4. Before and after every step, checks the tab hasn't navigated (generation or
   URL changed) or closed.
5. On success, writes the screenshot and pushes a `captured` node.
   `geometryStable` is whether the two layout reads match.
6. On failure, pushes an `uncaptured` node with the error `message`, and
   `reason` `navigated-away` if the tab navigated or closed, otherwise `error`.
   Explicit recordings rethrow. For automatic ones, `finish` fails the test on
   `error` only.

### Linking nodes

`linkPreviousNodes` runs in `finish`, once every recording has settled and
every opener is known:

1. The raw chain: each node's predecessor is the previous node in its tab. A
   popup's first node gets its opener tab's last node requested before it
   (compared by `requestedAtMs`, so later navigations in the opener don't
   count).
2. Uncaptured nodes stay in the chain, so `/start → /a (replaced) → /b`
   records `/b ← /a ← /start`. They are regular nodes in the server's graph,
   without a screenshot.

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

## Raw graphs and the manifest

Types in [`src/types.ts`](src/types.ts), `formatVersion: 1`.

**Per test.** `finish` writes a `RawGraphFile` to `ralph/raw_graph.json` in the
test's output directory and attaches it as `ralph-raw-graph`:

- `rawGraph` is the test's `RawGraph`: its metadata, `pages` (every tab:
  `pageId`, `browserName`, `openerPageId`), `nodes` sorted by page
  then sequence, and `complete`.
- Alongside it, what the reporter needs to merge and upload: `producer`,
  `runId`, `buildId`, the `config` snapshot, and the test's `mode` (`local` or
  `upload`). The upload target is the reporter's, not the test's.
- `status` is `failed` when the test passed but a recording failed, since
  `finish` fails the test after the file is written.

**Per run.** Workers are separate processes, so only a reporter sees every
test. `RalphReporter` reads each test's `ralph-raw-graph` attachment in
`onTestEnd`, keyed by test id so a retry replaces the attempt before it. In
`onEnd` it builds one `RawGraphManifest`:

- `artifactId` is new for every run, so each run (or shard, in `shard`) is its
  own artifact.
- `rawGraphs` holds each test's final attempt, sorted by project and title. Its
  `status` is replaced with the result's final one, and `complete` also needs
  that status to be `passed`, so failures after the recorder finished, e.g. in
  another fixture's teardown, are reflected.
- `screenshot.path` is rewritten to the node's path in the bundle.
- `config`, `runId`, and `buildId` must be the same for every test, or the run
  fails.
- It is written to `ralph/` in the first project's output directory (or the
  reporter's `outputDir` option) in the bundle's layout. It is uploaded when
  the reporter's own mode is `upload` or any test's is, to the reporter's
  `apiUrl` and `appId` (or `RALPH_API_URL`, else `https://api.ralphralph.ai`,
  and `RALPH_APP_ID`), with `RALPH_UPLOAD_KEY`. In `upload` mode the constructor resolves these, so
  missing credentials stop the run before any test.

The reporter sets `RALPH_PLAYWRIGHT_REPORTER` in its constructor, before any
worker starts, and workers inherit it. That is how the fixture tells the
reporter is on and refuses `upload` mode without it, instead of silently
uploading nothing. The `blob` reporter also satisfies it: a sharded run's blob
reports carry every attachment, and `playwright merge-reports` replays them
through the Ralph reporter in one process, which then sees every shard's tests
and uploads once. `config.shard` is null there, so the merged run has no
`shard`.

`linkPreviousNodes` links nodes within a test only. The server builds one graph
from every raw graph by merging nodes on their URLs.

## Upload

Two requests, both with `Authorization: Bearer <uploadKey>`:

1. `POST {apiUrl}/api/upload/artifact/prepare` with the JSON body
   `{ "externalAppId": appId }`. The server reserves an artifact and answers
   `{ result: 'ok', artifactId, resultUrl? }`. The result page works from this
   point, showing the run as uploading, then processing, then its graph, so the
   reporter prints the link before it uploads anything.
2. `POST {apiUrl}/api/upload/web/apps/{appId}/artifact/{artifactId}` with an
   `application/gzip` body, streamed as it is built:

   ```
   raw_graph.json               { manifest, screenshots: [{ nodeId, path }] }
   assets/images/<nodeId>.webp  (or .png)
   ```

   The manifest's `artifactId` must be the prepared one; the server refuses a
   bundle naming any other. It answers `{ result: 'ok', status: 'queued',
   artifactId, resultUrl?, replayed }` once the bundle is stored, and processes
   it afterwards, so an invalid bundle shows as failed on the result page rather
   than as an HTTP error.

- The reporter merges the tests before preparing, so a run that cannot be
  merged never reserves an artifact. The local copy is written after preparing
  and names the prepared artifact. If preparing fails, it is written with a
  random `artifactId` and the error says where.
- The tar entries have fixed `mtime`, `uid`, and `gid`, so the same artifact
  always produces the same bytes.
- Once one upload of an artifact is queued, the server answers any other with
  `replayed: true` without reading it. An upload that failed in transit can be
  retried to the same artifact.
- `nodeId` and `appId` are validated as path-safe before use.
- `apiUrl` must be `https:`, or `http:` for loopback hosts only.
- `redirect: 'error'`, so the key is never sent to a redirect target.
- `RALPH_UPLOAD_STORAGE=local` adds `?storage=local` to the upload, so the
  server writes the images to a temp directory on its own disk and hands back
  file paths instead of image URLs. For Ralph developers only, as a stopgap
  until local mode renders its own report: it is not a public option, and the
  server rejects it with `400` unless `allowLocalArtifactStorage` is on. Unset
  or `gcs` sends no parameter, so the bucket is the default.
- The receipt must echo the `artifactId`, or the upload is treated as failed.
- The reporter prints the server's `resultUrl` when it sends one, else
  `https://dash.ralphralph.ai/uploads/{artifactId}`. It also writes the receipt
  to `upload_receipt.json`.
- Limits: 16 MiB manifest JSON, 5,000 screenshots, 256 MiB of screenshots,
  256 MiB compressed. The compressed limit is enforced while streaming. The
  server also caps nodes at 20,000 per run and 5,000 per test.
- No automatic HTTP retries. Preparing times out after 30 s; the upload after
  `uploadTimeoutMs`, 120 s by default.

`prepareArtifactUpload({ apiUrl, appId, uploadKey })`,
`uploadRawGraph(manifest, screenshots, { apiUrl, appId, uploadKey, timeoutMs? })`
and `createRawGraphBundle(manifest, screenshots)` are exported so a saved result
can be uploaded again, e.g. from a later CI step: prepare, set the manifest's
`artifactId`, then upload. `screenshots` is one `{ nodeId, contentType, bytes }`
per captured node, read from the files the manifest references. They are
internal tooling and deliberately not documented in the README.

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
  get separate raw graphs and only the final one is merged.
- `test/playwright.config.ts` loads the reporter from `../dist/reporter.mjs`.
- After changing `@ralphralphai/config`'s schema, rebuild it before running
  these tests, or they validate against the old one.
