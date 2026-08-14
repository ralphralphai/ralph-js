// The types a `ralph.jsonc` declares.
//
// Types only, deliberately: every export here erases at compile time, so
// depending on the config contract costs a consumer no runtime code and no
// dependencies. That is what lets a React Native tracker use it as-is.
//
// They are generated, by `pnpm generate`, from the zod schemas in this package
// - via `schema/ralph.schema.json`, the same JSON Schema a `ralph.jsonc` points
// at. Zod is a devDependency and none of it is reachable from here, so it never
// reaches the published bundle or the published `.d.ts`.
//
// The engine that applies these rules is not here. It needs a `URL` with working
// `searchParams`, and it is private to the Ralph repo.

export type {
  Condition,
  DataFollowIgnoreRule,
  QueryParamCondition,
  ScreenSize,
  UrlNormalizeRule,
  UrlRuleMatcher,
  UrlTransformRule,
  Variant,
  VariantRule,
  WebRalphConfig,
} from '@/generated/config';
