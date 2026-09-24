// `@ralphralphai/config/zod`: the same contract as a set of zod schemas, for
// code that has to validate a config at runtime rather than just describe one.
//
// This is the only entry point with a runtime cost, and the only one that needs
// zod - an optional peer dependency, so installing this package for the types
// alone stays free. The root entry point imports nothing from here.
//
// The types in `@ralphralphai/config` are generated from these schemas, so a
// value that parses here satisfies `WebRalphConfig` by construction.

export { ConditionSchema } from '@/condition';
export { DataFollowIgnoreRuleSchema } from '@/data_follow_ignore';
export { HostOverrideRuleSchema } from '@/host_override';
export { QueryParamConditionSchema } from '@/query_param';
export { WebRalphConfigSchema } from '@/ralph';
export { ScreenSizeSchema } from '@/screen_size';
export {
  SimpleUrlCrawlRuleSchema,
  SimpleUrlCrawlScenarioSchema,
} from '@/simple_url_crawl';
export {
  UrlNormalizeRuleSchema,
  UrlRuleMatcherSchema,
  UrlTransformRuleSchema,
} from '@/url_normalize';
export { VariantRuleSchema, VariantSchema } from '@/variants';
