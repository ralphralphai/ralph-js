# @ralphralphai/config

The configuration contract for [Ralph](https://ralphralph.ai): the rules a
`ralph.jsonc` declares, in three shapes generated from one definition.

| Entry point                          | What                                                       | Cost                     |
| ------------------------------------ | ---------------------------------------------------------- | ------------------------ |
| `@ralphralphai/config`               | The types. Every export erases at compile time.            | Nothing. No dependencies |
| `@ralphralphai/config/schema.json`   | The JSON Schema, for a `ralph.jsonc` and your editor.       | Nothing                  |
| `@ralphralphai/config/zod`           | The same contract as zod schemas, to validate at runtime.  | Needs `zod` ^4           |

The types are generated from the zod schemas, via the JSON Schema, so the three
cannot drift. Only the `/zod` entry point carries runtime code, which is why the
root stays safe to depend on from anywhere, React Native included.

```bash
pnpm add -D @ralphralphai/config
```

## Authoring a `ralph.jsonc`

Point `$schema` at the packaged file and your editor completes and validates the
config as you type. Comments are fine: Ralph reads the file as JSONC.

```jsonc
{
  "$schema": "./node_modules/@ralphralphai/config/schema/ralph.schema.json",

  "screenSizes": [
    { "width": 1280, "height": 720 },
    { "width": 402, "height": 874 }
  ],

  // Collapse every product page onto one analytics URL, so a heatmap aggregates
  // across them instead of splitting per id.
  "urlAnalysisNormalizeRules": [
    {
      "matcher": { "path": { "prefix": "/product/" } },
      "transform": { "updatedPath": "/product/:id", "removeOtherQueryParams": true }
    }
  ]
}
```

Without the package installed, point `$schema` at the published copy instead:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/ralphralphai/ralph-js/main/packages/config/schema/ralph.schema.json"
}
```

### Conditions


```jsonc
"path": "/checkout"
// Arrays are treated as "OR".
"path": ["/checkout", "/cart"]
```

Anything else is named by its only key:

```jsonc
"path": { "exact":    "/checkout" }
"path": { "prefix":   "/product/" }
"path": { "suffix":   ".pdf" }
"path": { "contains": ["/admin/", "/internal/"] }
"path": { "regex":    "^/p/\\d+$" }
"path": { "isSet":    true }        // the string is there at all
```

`any`, `all` and `not` nest those into a tree:

```jsonc
"path": {
  "all": [
    { "prefix": "/product/" },
    { "not": { "contains": "/preview" } }
  ]
}
```

### Matching query params

`queryParams` evaluates the condition on the (key, value) pairs.

```jsonc
"matcher": {
  "queryParams": {
    "all": [
      // ?checkout=stripe or ?checkout=paypal ...
      { "key": "checkout", "value": ["stripe", "paypal"] },
      // ... on a URL carrying no campaign params at all.
      { "not": { "key": { "prefix": "utm_" } } }
    ]
  }
}
```

### Rewriting query params

```jsonc
"transform": {
  "queryParams": [
    { "set": "page", "value": "1" },
    { "remove": { "prefix": "utm_" } }
  ],
  "removeOtherQueryParams": true
}
```

The edits apply in order. `set` rewrites the value of every param whose key
matches. `removeOtherQueryParams` drops everything the list did
not touch when specified.

## Validating at runtime

For code that reads a config rather than writes one. `zod` is an optional peer
dependency: install it alongside this package if you import this entry point.

```ts
import { WebRalphConfigSchema } from '@ralphralphai/config/zod';

const config = WebRalphConfigSchema.parse(JSON.parse(contents));
```

A parsed value satisfies `WebRalphConfig` by construction, and a misspelled rule
fails with the path of the field that is wrong rather than parsing into a rule
that silently never matches.

## Development

`src/*.ts` holds the zod schemas, and they are the only definition of the
contract. `pnpm generate` — which `pnpm build` and `pnpm check` run first —
regenerates both derived artifacts from them:

- `schema/ralph.schema.json`, committed so it can be linked to
- `src/generated/config.ts`, the types `src/index.ts` re-exports

Going through JSON Schema rather than `z.infer` is what keeps zod out of the
published `.d.ts`. Editing either generated file by hand is pointless; edit the
schema and run `pnpm generate`.

## License

Apache-2.0
