import { z } from 'zod';

import { DataFollowIgnoreRuleSchema } from '@/data_follow_ignore';
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

    urlAnalysisNormalizeRules: UrlNormalizeRuleSchema.array()
      .optional()
      .describe(
        'Normalize rules to apply to the URLs for the data aggregation, in order. E.g. user identifying query params to the URL should be irrelevant for the analysis.',
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
