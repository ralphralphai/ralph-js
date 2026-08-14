import { z } from 'zod';

import { ConditionSchema, UrlRuleMatcherSchema } from '@/url_normalize';

export const DataFollowIgnoreRuleSchema = z
  .object({
    rules: z
      .object({
        matcher: UrlRuleMatcherSchema,
        // Left undescribed on purpose: `.describe()` clones the schema, which
        // would drop the `Condition` id and inline the recursive definition.
        ignore: ConditionSchema,
      })
      .array()
      .optional(),
  })
  .meta({
    id: 'DataFollowIgnoreRule',
    description:
      'Follow ids the crawler should not follow on the URLs a matcher matches. Without this, follow ids that appear on every page (nav bars, footers) get clicked from every node, so the crawler keeps re-visiting the same destinations.',
  });
