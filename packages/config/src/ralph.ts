import type { DataFollowIgnoreRule } from '@/data_follow_ignore';
import type { ScreenSize } from '@/screen_size';
import type { UrlNormalizeRule } from '@/url_normalize';
import type { VariantRule } from '@/variants';

export type WebRalphConfig = {
  /**
   * List of URLs to initiate the crawl. Should be publicly accessible.
   */
  urlsToCrawl?: string[];

  /**
   * Normalize rules to apply to the URLs for the data aggregation. E.g. user
   * identifying query params to the URL should be irrelevant for the analysis.
   */
  urlAnalysisNormalizeRule?: UrlNormalizeRule;

  /**
   * Normalize rules to apply to the URLs for the crawl.
   *
   * When the crawler visits a matching URL, the normalize rule will be applied.
   * This helps deduping the URLs when building the Web navigation graph.
   */
  urlCrawlNormalizeRules?: UrlNormalizeRule;

  /**
   * Variant rules to apply to the specific URL.
   *
   * e.g. if we are A/B testing multiple versions on the same page, you can use
   * the variant rules to identify different versions and aggregate them.
   */
  variantRules?: VariantRule;

  /**
   * Follow ids to skip on matched URLs, so the crawler doesn't keep re-visiting
   * nav-bar/footer links that appear on every page.
   */
  dataFollowIgnoreRule?: DataFollowIgnoreRule;

  /**
   * Screen sizes to run the crawl / capture screenshots at.
   */
  screenSizes: ScreenSize[];
};
