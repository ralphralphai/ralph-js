// The types a `ralph.config.json` declares.
//
// Types only, deliberately: every export here erases at compile time, so
// depending on the config contract costs a consumer no runtime code and no
// dependencies. That is what lets a React Native tracker use it as-is.
//
// The engine that applies these rules is not here. It needs a `URL` with working
// `searchParams`, and it is private to the Ralph repo.

export type { DataFollowIgnoreRule } from '@/data_follow_ignore';
export type { RalphConfig } from '@/ralph';
export type { ScreenSize } from '@/screen_size';
export type {
  Condition,
  Matcher,
  UrlNormalizeRule,
  UrlRuleMatcher,
  UrlTransformRule,
} from '@/url_normalize';
export type { Variant, VariantRule } from '@/variants';
