import { z } from 'zod';

import { HostOverrideRuleSchema } from '@/host_override';
import { ScreenSizeSchema } from '@/screen_size';
import { SimpleUrlCrawlRuleSchema } from '@/simple_url_crawl';
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

    simpleUrlCrawlRules: SimpleUrlCrawlRuleSchema.array()
      .optional()
      .describe(
        'URLs to crawl without scripted steps, each with its own normalize rules. Flows that need interaction are captured by Playwright tests instead.',
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

    variantRules: VariantRuleSchema.array()
      .optional()
      .describe(
        'Variant rules to apply to the specific URL. E.g. when A/B testing multiple versions of the same page, the variant rules identify the versions so they can be aggregated.',
      ),

    screenSizes: z
      .array(ScreenSizeSchema)
      .describe('Screen sizes to run the crawl / capture screenshots at.'),
  })
  .meta({
    id: 'WebRalphConfig',
    description: 'The crawl configuration a `ralph.jsonc` declares.',
  });
