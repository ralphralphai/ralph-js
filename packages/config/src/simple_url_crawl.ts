import { z } from 'zod';

import { DataFollowIgnoreRuleSchema } from '@/data_follow_ignore';

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
    dataFollowIgnoreRules: DataFollowIgnoreRuleSchema.array()
      .optional()
      .describe(
        "Follow ids to skip on matched URLs, so the crawler doesn't keep re-visiting nav-bar/footer links that appear on every page.",
      ),
  })
  .meta({
    id: 'SimpleUrlCrawlScenario',
    description:
      'One URL to start crawling from, and which follow ids to skip. The URLs it reaches are normalized by the top-level `graphUrlNormalizeRules`.',
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
