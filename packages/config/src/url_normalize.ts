import { z } from 'zod';

// A value that accepts either one string or a list of them, in which case any
// member matching is a match.
const matchValue = z
  .union([z.string(), z.string().array()])
  .describe('A single string, or a list in which any member matching matches.');

export const MatcherSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('exact'),
      value: matchValue,
    }),
    z.object({
      type: z.literal('prefix'),
      value: matchValue,
    }),
    z.object({
      type: z.literal('suffix'),
      value: matchValue,
    }),
    z.object({
      type: z.literal('contains'),
      value: matchValue,
    }),
    z.object({
      type: z.literal('regex'),
      value: z.string().describe('A regular expression source string.'),
    }),
    z.object({
      type: z.literal('is-set'),
    }),
  ])
  .meta({
    id: 'Matcher',
    description: 'How a single string is tested against the rule.',
  });

// `Condition` nests inside itself, so it needs `z.lazy` and, with it, an
// explicit type: `z.lazy` cannot infer a recursive type on its own. This is not
// the published `Condition` - that one is generated from the schema below, like
// every other type this package exports.
type Condition =
  | { type: 'and'; conditions: Condition[] }
  | { type: 'or'; conditions: Condition[] }
  | { type: 'not'; condition: Condition }
  | { type: 'matcher'; matcher: z.infer<typeof MatcherSchema> };

export const ConditionSchema: z.ZodType<Condition> = z
  .lazy(() =>
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('and'),
        conditions: z.array(ConditionSchema),
      }),
      z.object({
        type: z.literal('or'),
        conditions: z.array(ConditionSchema),
      }),
      z.object({
        type: z.literal('not'),
        condition: ConditionSchema,
      }),
      z.object({
        type: z.literal('matcher'),
        matcher: MatcherSchema,
      }),
    ]),
  )
  .meta({
    id: 'Condition',
    description:
      'A matcher, or `and` / `or` / `not` nesting other conditions around one.',
  });

export const UrlRuleMatcherSchema = z
  .object({
    path: ConditionSchema.optional().describe(
      'Matched against the URL path, e.g. `/product/42`.',
    ),
    queryParam: z
      .object({
        key: ConditionSchema,
        value: ConditionSchema,
      })
      .optional()
      .describe(
        'Matches when the URL carries a query param whose key and value both match.',
      ),
  })
  .meta({
    id: 'UrlRuleMatcher',
    description: 'Which URLs a rule applies to. An empty matcher matches all.',
  });

export const UrlTransformRuleSchema = z
  .object({
    updatedPath: z
      .string()
      .optional()
      .describe('Update the path of the URL to the given value.'),
    updateMatchedQueryParams: z
      .discriminatedUnion('type', [
        z.object({
          type: z.literal('set'),
          key: ConditionSchema,
          value: z.string(),
        }),
        z.object({
          type: z.literal('remove'),
          key: ConditionSchema,
        }),
      ])
      .optional()
      .describe(
        'Add the given query key & value to the URL. If the query key already exists, it will be updated.',
      ),
    removeNotUpdatedQueryParams: z
      .boolean()
      .optional()
      .describe(
        'If set, then remove all other query params that are not touched by the updated query params.',
      ),
  })
  .meta({
    id: 'UrlTransformRule',
    description: 'What to rewrite on a URL the matcher matched.',
  });

export const UrlNormalizeRuleSchema = z
  .object({
    rules: z
      .object({
        matcher: UrlRuleMatcherSchema,
        transform: UrlTransformRuleSchema,
      })
      .array()
      .optional(),
  })
  .meta({
    id: 'UrlNormalizeRule',
    description: 'Matcher / transform pairs applied to a URL in order.',
  });
