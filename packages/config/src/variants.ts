import { z } from 'zod';

import { UrlRuleMatcherSchema } from '@/url_normalize';

export const VariantSchema = z
  .object({
    id: z.string().describe('The id this variant is aggregated under.'),
    queryParams: z
      .object({
        key: z.string(),
        value: z.string(),
      })
      .array()
      .optional()
      .describe('The query params that identify this variant.'),
  })
  .meta({
    id: 'Variant',
    description: 'One version of a page, identified by its query params.',
  });

export const VariantRuleSchema = z
  .object({
    rules: z
      .object({
        matcher: UrlRuleMatcherSchema,
        variants: VariantSchema.array(),
      })
      .array()
      .optional(),
  })
  .meta({
    id: 'VariantRule',
    description: 'The variants to look for on the URLs a matcher matches.',
  });
