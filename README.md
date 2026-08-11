# ralph-js

The public JavaScript packages for [Ralph](https://ralphralph.ai), a
web-navigation-graph crawler and user-interaction analytics product. The
browser SDK records real clicks, scroll depth and pointer position so the
viewer can overlay those interactions onto the captured screenshots as
heatmaps.

| Package                                     | What                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| [`@ralphralphai/tracker`](packages/tracker) | The browser SDK. React components plus the batching tracker.                |
| [`@ralphralphai/config`](packages/config)   | The rule types a `ralph.config.json` declares. Types only, no runtime code. |
