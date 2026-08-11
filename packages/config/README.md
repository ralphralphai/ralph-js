# @ralphralphai/config

The configuration contract for [Ralph](https://ralphralph.ai): the rule types
a `ralph.config.json` declares.

Types only, with no dependencies and no runtime code. Every export erases at compile time,
so this is safe to depend on from anywhere, React Native included.

```bash
pnpm add -D @ralphralphai/config
```

## Authoring a config

```ts
import type { RalphConfig } from '@ralphralphai/config';

const config: RalphConfig = {
  screenSizes: [
    { width: 1280, height: 720 },
    { width: 402, height: 874 },
  ],

  // Collapse every product page onto one analytics URL, so a heatmap aggregates
  // across them instead of splitting per id.
  urlNormalizeRules: {
    rules: [
      {
        matcher: {
          path: { type: 'matcher', matcher: { type: 'prefix', value: '/product/' } },
        },
        transform: { updatedPath: '/product/:id', removeNotUpdatedQueryParams: true },
      },
    ],
  },

  // Stop the crawler re-visiting nav links that appear on every page.
  dataFollowIgnoreRule: {
    rules: [
      {
        matcher: { path: { type: 'matcher', matcher: { type: 'prefix', value: '/' } } },
        ignore: { type: 'matcher', matcher: { type: 'prefix', value: 'nav-' } },
      },
    ],
  },
};
```

Rules are built from `Condition`s, which nest with `and` / `or` / `not` around a
`Matcher`: one of `exact`, `prefix`, `suffix`, `contains`, `regex`, or `is-set`. Matchers
taking a `value` accept a single string or an array, in which case any member matching is
a match.

## What this package does not do

It does not apply the rules, and it does not validate them. Both live in
[Ralph](https://ralphralph.ai) itself: the engine that normalizes a URL runs
crawler-side, and the crawler validates a config file as it reads it from disk.

Practically, that means a config is checked when you compile and when the crawler loads
it, not when you construct one at runtime.

## License

Apache-2.0
