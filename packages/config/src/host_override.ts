import { z } from 'zod';

import { UrlRuleMatcherSchema } from '@/url_normalize';

export const HostOverrideRuleSchema = z
  .strictObject({
    matcher: UrlRuleMatcherSchema,
    updatedHost: z
      .string()
      .describe(
        'The host to record instead, e.g. `halfmore.co`. It replaces the host whole, so carry the port when the graph should have one.',
      ),
  })
  .meta({
    id: 'HostOverrideRule',
    description:
      'The host the graph records for the URLs a matcher matches, in place of the one the crawler visited.',
  });
