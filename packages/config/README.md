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

`host` and `path` both take one, so a rule can be scoped to a subdomain:

```jsonc
"matcher": {
  "host": { "suffix": ".halfmore.co" },
  "path": { "prefix": "/product/" }
}
```

The host is matched as the URL carries it, port included — `halfmore.co`, or
`localhost:3000`.

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

### Overriding the host in the graph

When the crawl and the tracker run on different hosts, the graph records a URL
the tracker never reports and the two never join. `hostOverrides` rewrites the
host as the graph is built:

```jsonc
{
  "urlsToCrawl": ["https://dev.web.halfmore.co"],

  // Crawl dev, record production.
  "hostOverrides": [
    {
      "matcher": { "host": "dev.web.halfmore.co" },
      "updatedHost": "halfmore.co"
    },
    {
      "matcher": { "host": { "prefix": "dev.api." } },
      "updatedHost": "api.halfmore.co"
    }
  ]
}
```

The first rule whose matcher matches wins and the rest are skipped, so a host a
rule rewrote is never rewritten again by a later one. The matcher is the same
one every other rule takes, so `path` and `queryParams` can narrow it further.

This changes only the host the graph records. The crawler still visits the host
it was pointed at — put a rule in `urlCrawlNormalizeRules` to change that.

## Declaring crawl scenarios

`crawlRules` is a list of rules. Each rule keeps its URL matcher in `at`,
its named scenarios in `scenarios`, and reusable step sequences in `sequences`.
A scenario or sequence holds an ordered `steps` array.

```jsonc
{
  "screenSizes": [{ "width": 1280, "height": 720 }],
  "crawlRules": [
    {
      "at": { "path": "/login" },
      "sequences": [
        { "name": "submit", "steps": [{ "click": "submit" }] }
      ],
      "scenarios": [
        {
          "name": "Sign in",
          "steps": [
            { "fill": "email", "value": { "var": "email" } },
            { "run": "submit" },
            { "waitFor": "status", "expectedValue": "ready", "timeoutMs": 5000 }
          ]
        }
      ]
    }
  ]
}
```

Each step specifies exactly one operation: `click`, `fill`, `waitFor`, `run`,
or `fetchUrl`. No separate `action` field is needed. `fill` accepts a literal
string or a variable reference such as `{ "var": "email" }`. `fetchUrl` takes
`body` and `saveAs`, which names the response variable. A wait defaults to
3000 milliseconds; explicit timeouts must be nonnegative integers.
Unknown fields and mixed operations are rejected.

This package defines the configuration shape; it does not execute a crawl.
Element conditions retain the existing `Condition` shape. The crawl engine
must define what element property they match, what `expectedValue` observes,
scenario isolation, sequence and variable scope, and HTTP request behavior.
Reference existence and sequence cycles are not checked by these schemas.

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
