import { z } from 'zod';

import { ConditionSchema } from '@/condition';

// Mirrors `Condition`, but over key/value pairs rather than single strings, and
// so recursive for the same reason - see the note in `src/condition.ts`.
type QueryParamCondition =
  | {
      key: z.input<typeof ConditionSchema>;
      value?: z.input<typeof ConditionSchema>;
    }
  | { any: QueryParamCondition[] }
  | { all: QueryParamCondition[] }
  | { not: QueryParamCondition };

export const QueryParamConditionSchema: z.ZodType<QueryParamCondition> = z
  .lazy(() =>
    z.union([
      z.strictObject({
        // The two conditions are tested against the same param, which is the
        // whole point of the leaf: `{ key: 'a', value: '2' }` does not match
        // `?a=1&b=2`.
        key: ConditionSchema,
        value: ConditionSchema.optional(),
      }),
      z.strictObject({ any: z.array(QueryParamConditionSchema) }),
      z.strictObject({ all: z.array(QueryParamConditionSchema) }),
      z.strictObject({ not: QueryParamConditionSchema }),
    ]),
  )
  .meta({
    id: 'QueryParamCondition',
    description:
      "How a URL's query params are tested. `{ key, value }` matches when some single param has a key and a value that both match - omit `value` to test only that the key is there. `any` / `all` / `not` combine those, so `not` means no param satisfies it.",
  });
