import type { DataFollowIgnoreRule } from '@/data_follow_ignore';
import type { ScreenSize } from '@/screen_size';
import type { UrlNormalizeRule } from '@/url_normalize';
import type { VariantRule } from '@/variants';

export type RalphConfig = {
  urlNormalizeRules?: UrlNormalizeRule;
  variantRules?: VariantRule;
  // Follow ids to skip on matched URLs, so the crawler doesn't keep re-visiting
  // nav-bar/footer links that appear on every page.
  dataFollowIgnoreRule?: DataFollowIgnoreRule;

  // Screen sizes to run the crawl / capture screenshots at.
  screenSizes: ScreenSize[];
};
