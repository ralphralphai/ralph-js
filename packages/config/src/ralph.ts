import { z } from 'zod';

import { DataFollowIgnoreRuleSchema } from '@/data_follow_ignore';
import { ScreenSizeSchema } from '@/screen_size';
import { UrlNormalizeRuleSchema } from '@/url_normalize';
import { VariantRuleSchema } from '@/variants';

export const WebRalphConfigSchema = z
  .object({
    urlsToCrawl: z
      .string()
      .array()
      .optional()
      .describe(
        'List of URLs to initiate the crawl. Should be publicly accessible.',
      ),

    urlAnalysisNormalizeRules: UrlNormalizeRuleSchema.optional().describe(
      'Normalize rules to apply to the URLs for the data aggregation. E.g. user identifying query params to the URL should be irrelevant for the analysis.',
    ),
    urlCrawlNormalizeRules: UrlNormalizeRuleSchema.optional().describe(
      'Normalize rules to apply to the URLs for the crawl. Applied as the crawler visits a matching URL, which dedupes the URLs when building the Web navigation graph.',
    ),

    variantRules: VariantRuleSchema.optional().describe(
      'Variant rules to apply to the specific URL. E.g. when A/B testing multiple versions of the same page, the variant rules identify the versions so they can be aggregated.',
    ),

    dataFollowIgnoreRule: DataFollowIgnoreRuleSchema.optional().describe(
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
