import { z } from 'zod';

// A value that accepts either one string or a list of them, in which case any
// member matching is a match.
const matchValue = z
  .union([z.string(), z.string().array()])
  .describe('A single string, or a list in which any member matching matches.');

// `Condition` nests inside itself, so it needs `z.lazy` and, with it, an
// explicit type: `z.lazy` cannot infer a recursive type on its own. This is not
// the published `Condition` - that one is generated from the schema below, like
// every other type this package exports.
type Condition =
  | string
  | string[]
  | { exact: string | string[] }
  | { prefix: string | string[] }
  | { suffix: string | string[] }
  | { contains: string | string[] }
  | { regex: string | string[] }
  | { isSet: true }
  | { any: Condition[] }
  | { all: Condition[] }
  | { not: Condition };

// Every branch is a `strictObject` so that exactly one of them can claim a
// given value. Without it `{ prefix: '/a', sufix: '/b' }` would parse as a
// prefix match and silently drop the typo'd half.
export const ConditionSchema: z.ZodType<Condition> = z
  .lazy(() =>
    z.union([
      matchValue,
      z.strictObject({ exact: matchValue }),
      z.strictObject({ prefix: matchValue }),
      z.strictObject({ suffix: matchValue }),
      z.strictObject({ contains: matchValue }),
      z.strictObject({
        regex: z
          .union([z.string(), z.string().array()])
          .describe(
            'A regular expression source string, or a list in which any member matching matches.',
          ),
      }),
      z.strictObject({
        isSet: z
          .literal(true)
          .describe('Matches whenever the string exists at all.'),
      }),
      z.strictObject({ any: z.array(ConditionSchema) }),
      z.strictObject({ all: z.array(ConditionSchema) }),
      z.strictObject({ not: ConditionSchema }),
    ]),
  )
  .meta({
    id: 'Condition',
    description:
      'How a string is tested. A bare string - or a list of them, any of which may match - is an exact match; `exact` / `prefix` / `suffix` / `contains` / `regex` / `isSet` name another test; `any` / `all` / `not` combine them.',
  });
