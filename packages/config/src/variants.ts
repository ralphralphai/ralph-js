import { z } from 'zod';

import { UrlRuleMatcherSchema } from '@/url_normalize';

export const VariantSchema = z
  .strictObject({
    id: z.string().describe('The id this variant is aggregated under.'),
    queryParams: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'The query params that identify this variant, as exact key / value pairs. Omit it for the variant a URL carrying none of the others falls back to.',
      ),
  })
  .meta({
    id: 'Variant',
    description: 'One version of a page, identified by its query params.',
  });

export const VariantRuleSchema = z
  .strictObject({
    matcher: UrlRuleMatcherSchema,
    variants: VariantSchema.array(),
  })
  .meta({
    id: 'VariantRule',
    description: 'The variants to look for on the URLs a matcher matches.',
  });
