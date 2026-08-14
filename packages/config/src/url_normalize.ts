import { z } from 'zod';

import { ConditionSchema } from '@/condition';
import { QueryParamConditionSchema } from '@/query_param';

export const UrlRuleMatcherSchema = z
  .strictObject({
    path: ConditionSchema.optional().describe(
      'Matched against the URL path, e.g. `/product/42`.',
    ),
    queryParams: QueryParamConditionSchema.optional(),
  })
  .meta({
    id: 'UrlRuleMatcher',
    description:
      'Which URLs a rule applies to. Both fields have to match; an empty matcher matches all.',
  });

export const UrlTransformRuleSchema = z
  .strictObject({
    updatedPath: z
      .string()
      .optional()
      .describe('Update the path of the URL to the given value.'),
    queryParams: z
      .union([
        z.strictObject({
          set: ConditionSchema,
          value: z.string(),
        }),
        z.strictObject({
          remove: ConditionSchema,
        }),
      ])
      .array()
      .optional()
      .describe(
        'Query param edits, applied in order. `set` rewrites the value of every param whose key matches, and appends the param when the key is a plain string and no param carries it; `remove` drops every param whose key matches.',
      ),
    removeOtherQueryParams: z
      .boolean()
      .optional()
      .describe(
        'If set, drop every query param that `queryParams` did not touch.',
      ),
  })
  .meta({
    id: 'UrlTransformRule',
    description: 'What to rewrite on a URL the matcher matched.',
  });

export const UrlNormalizeRuleSchema = z
  .strictObject({
    matcher: UrlRuleMatcherSchema,
    transform: UrlTransformRuleSchema,
  })
  .meta({
    id: 'UrlNormalizeRule',
    description: 'A transform to apply to the URLs a matcher matches.',
  });
