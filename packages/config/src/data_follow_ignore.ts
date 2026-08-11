import type { Condition, UrlRuleMatcher } from '@/url_normalize';

// Rules for follow ids the crawler should NOT follow on certain pages. Without
// this, follow ids that appear on every page (nav bars, footers) get clicked
// from every node, so the crawler keeps re-visiting the same destinations.
export type DataFollowIgnoreRule = {
  rules?: {
    matcher: UrlRuleMatcher;
    // Follow ids matching this condition are ignored while the crawler is on
    // a URL the matcher matches.
    ignore: Condition;
  }[];
};
