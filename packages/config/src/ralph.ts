import { z } from 'zod';

import { CrawlRuleSchema } from '@/crawl';
import { DataFollowIgnoreRuleSchema } from '@/data_follow_ignore';
import { HostOverrideRuleSchema } from '@/host_override';
import { ScreenSizeSchema } from '@/screen_size';
import { UrlNormalizeRuleSchema } from '@/url_normalize';
import { VariantRuleSchema } from '@/variants';

export const WebRalphConfigSchema = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .describe(
        'Pointer to this JSON Schema, so an editor completes and validates the file.',
      ),

    urlsToCrawl: z
      .string()
      .array()
      .optional()
      .describe(
        'List of URLs to initiate the crawl. Should be accessible from the crawler.',
      ),

    hostOverrides: HostOverrideRuleSchema.array()
      .optional()
      .describe(
        'Host rewrites applied when the Web navigation graph is built, for when the crawl and the tracker run on different hosts: the crawler visits `dev.web.halfmore.co`, the tracker reports from `halfmore.co`, and the graph has to record the host the tracker reports for the two to join. The first rule whose matcher matches wins and the rest are skipped, so a rewritten host is never rewritten again. The crawl itself is untouched - only the host the graph records changes.',
      ),

    urlAnalysisNormalizeRules: UrlNormalizeRuleSchema.array()
      .optional()
      .describe(
        'Normalize rules to apply to the URLs for the data aggregation, in order. E.g. user identifying query params to the URL should be irrelevant for the analysis.',
      ),

    crawlRules: CrawlRuleSchema.optional().describe(
      'Crawl scenarios and reusable sequences for matching URLs.',
    ),

    urlCrawlNormalizeRules: UrlNormalizeRuleSchema.array()
      .optional()
      .describe(
        'Normalize rules to apply to the URLs for the crawl, in order. Applied as the crawler visits a matching URL, which dedupes the URLs when building the Web navigation graph.',
      ),

    variantRules: VariantRuleSchema.array()
      .optional()
      .describe(
        'Variant rules to apply to the specific URL. E.g. when A/B testing multiple versions of the same page, the variant rules identify the versions so they can be aggregated.',
      ),

    dataFollowIgnoreRules: DataFollowIgnoreRuleSchema.array()
      .optional()
      .describe(
        "Follow ids to skip on matched URLs, so the crawler doesn't keep re-visiting nav-bar/footer links that appear on every page.",
      ),

    screenSizes: z
      .array(ScreenSizeSchema)
      .describe('Screen sizes to run the crawl / capture screenshots at.'),
  })
  .meta({
    id: 'WebRalphConfig',
    description: 'The crawl configuration a `ralph.jsonc` declares.',
  });
