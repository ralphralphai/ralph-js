import { describe, expect, it } from 'vitest';

import type { WebRalphConfig } from '@/index';
import { WebRalphConfigSchema } from '@/ralph';

describe('WebRalphConfigSchema', () => {
  // The published types are generated from this schema, so the two agree by
  // construction. This is the check that the generation step actually ran and
  // that both ends still describe the same config: it fails to compile if the
  // type drifts, and fails to parse if the schema does.
  it('parses a value that satisfies the published WebRalphConfig type', () => {
    const config: WebRalphConfig = {
      urlsToCrawl: ['https://example.com'],
      screenSizes: [{ width: 1280, height: 720 }],
      urlAnalysisNormalizeRules: {
        rules: [
          {
            matcher: {
              path: {
                type: 'matcher',
                matcher: { type: 'prefix', value: '/product/' },
              },
            },
            transform: {
              updatedPath: '/product/:id',
              removeNotUpdatedQueryParams: true,
            },
          },
        ],
      },
      variantRules: {
        rules: [
          {
            matcher: { path: { type: 'matcher', matcher: { type: 'is-set' } } },
            variants: [{ id: 'b', queryParams: [{ key: 'v', value: 'b' }] }],
          },
        ],
      },
    };

    expect(WebRalphConfigSchema.parse(config)).toEqual(config);
  });

  it('accepts a config that declares no rules', () => {
    expect(WebRalphConfigSchema.safeParse({ screenSizes: [] }).success).toBe(
      true,
    );
  });

  it('rejects a config with no screenSizes', () => {
    expect(WebRalphConfigSchema.safeParse({}).success).toBe(false);
  });

  it('accepts the `$schema` pointer a `ralph.jsonc` carries', () => {
    const result = WebRalphConfigSchema.safeParse({
      $schema: './node_modules/@ralphralphai/config/schema/ralph.schema.json',
      screenSizes: [{ width: 1280, height: 720 }],
    });

    expect(result.success).toBe(true);
  });

  // The property the crawler's `loadConfig` leans on: a misspelled matcher has
  // to surface as an error naming the field, not as a rule that parses and then
  // silently never matches.
  it('names the offending path when a matcher type is misspelled', () => {
    const result = WebRalphConfigSchema.safeParse({
      screenSizes: [],
      urlAnalysisNormalizeRules: {
        rules: [
          {
            matcher: {
              path: {
                type: 'matcher',
                matcher: { type: 'prefixx', value: '/a' },
              },
            },
            transform: {},
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'urlAnalysisNormalizeRules.rules.0.matcher.path.matcher.type',
    );
  });

  it('parses a nested condition', () => {
    const result = WebRalphConfigSchema.safeParse({
      screenSizes: [{ width: 402, height: 874 }],
      dataFollowIgnoreRule: {
        rules: [
          {
            matcher: {},
            ignore: {
              type: 'or',
              conditions: [
                { type: 'matcher', matcher: { type: 'prefix', value: 'nav-' } },
                {
                  type: 'not',
                  condition: {
                    type: 'matcher',
                    matcher: { type: 'contains', value: ['footer', 'header'] },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
  });
});
