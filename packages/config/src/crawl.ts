import { z } from 'zod';

import { ConditionSchema } from '@/condition';
import { UrlRuleMatcherSchema } from '@/url_normalize';

// Strict branches keep each step unambiguous: a step cannot both click and run
// a sequence, and misspelled options must not silently disappear.
export const CrawlStepSchema = z
  .union([
    z.strictObject({
      run: z.string().min(1).describe('Name of a reusable sequence to run.'),
    }),
    z.strictObject({
      click: ConditionSchema,
    }),
    z.strictObject({
      fill: ConditionSchema,
      value: z.union([z.string(), z.strictObject({ var: z.string().min(1) })]),
    }),
    z.strictObject({
      waitFor: ConditionSchema,
      expectedValue: ConditionSchema,
      timeoutMs: z.number().int().nonnegative().default(3000),
    }),
    z.strictObject({
      fetchUrl: z.string(),
      body: z.record(z.string(), z.string()),
      saveAs: z.string().min(1).describe('Variable name for the response.'),
    }),
  ])
  .meta({
    id: 'CrawlStep',
    description: 'One crawl operation. Specify exactly one operation per step.',
  });

export const CrawlScenarioSchema = z
  .strictObject({
    name: z.string().optional(),
    steps: CrawlStepSchema.array().describe('Steps to execute in order.'),
  })
  .meta({ id: 'CrawlScenario' });

export const CrawlSequenceSchema = z
  .strictObject({
    name: z.string().min(1),
    steps: CrawlStepSchema.array().describe('Steps to execute in order.'),
  })
  .meta({ id: 'CrawlSequence' });

export const CrawlRuleSchema = z
  .strictObject({
    rules: z
      .strictObject({
        at: UrlRuleMatcherSchema,
        scenarios: CrawlScenarioSchema.array().optional(),
        visitDataFollow: z
          .boolean()
          .optional()
          .describe(
            'Whether to follow buttons annotated with data-follow-id. When not specified, it uses the visitDataFollowByDefault by default',
          ),
      })
      .array(),
    sequences: CrawlSequenceSchema.array()
      .optional()
      .describe('Named step sequences referenced by a step in the scenario'),
    visitDataFollowByDefault: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'Whether to follow buttons annotated with data-follow-id by default',
      ),
  })
  .meta({
    id: 'CrawlRule',
    description: 'Crawl scenarios and reusable sequences for matching URLs.',
  });
