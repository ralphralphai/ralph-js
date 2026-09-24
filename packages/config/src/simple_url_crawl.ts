import { z } from 'zod';

import { DataFollowIgnoreRuleSchema } from '@/data_follow_ignore';
import { UrlNormalizeRuleSchema } from '@/url_normalize';

export const SimpleUrlCrawlScenarioSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .optional()
      .describe('A label for the scenario, e.g. `Product listing`.'),
    startUrl: z
      .url()
      .describe(
        'The URL the crawl starts from. Should be accessible from the crawler.',
      ),
    urlNormalizeRules: UrlNormalizeRuleSchema.array()
      .optional()
      .describe(
        'Normalize rules to apply, in order, to the URLs this scenario visits. Dedupes the URLs when building the Web navigation graph.',
      ),
    dataFollowIgnoreRules: DataFollowIgnoreRuleSchema.array()
      .optional()
      .describe(
        "Follow ids to skip on matched URLs, so the crawler doesn't keep re-visiting nav-bar/footer links that appear on every page.",
      ),
  })
  .meta({
    id: 'SimpleUrlCrawlScenario',
    description:
      'One URL to start crawling from, how to normalize the URLs it reaches, and which follow ids to skip.',
  });

export const SimpleUrlCrawlRuleSchema = z
  .strictObject({
    scenario: SimpleUrlCrawlScenarioSchema,
  })
  .meta({
    id: 'SimpleUrlCrawlRule',
    description:
      'A crawl that starts from one URL and follows links, without scripted steps. Use Playwright tests for flows that need interaction.',
  });
