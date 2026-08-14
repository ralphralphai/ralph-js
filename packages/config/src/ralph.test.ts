import { describe, expect, it } from 'vitest';

import { ConditionSchema } from '@/condition';
import type { WebRalphConfig } from '@/index';
import { QueryParamConditionSchema } from '@/query_param';
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
      urlAnalysisNormalizeRules: [
        {
          matcher: { path: { prefix: '/product/' } },
          transform: {
            updatedPath: '/product/:id',
            removeOtherQueryParams: true,
          },
        },
      ],
      variantRules: [
        {
          matcher: { path: { isSet: true } },
          variants: [{ id: 'b', queryParams: { v: 'b' } }],
        },
      ],
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

  it('rejects a misspelled top-level field', () => {
    expect(
      WebRalphConfigSchema.safeParse({ screenSizes: [], urlsToCrwal: [] })
        .success,
    ).toBe(false);
  });

  // The property the crawler's `loadConfig` leans on: a misspelled matcher has
  // to surface as an error naming the field, not as a rule that parses and then
  // silently never matches.
  it('names the offending path when a condition is misspelled', () => {
    const result = WebRalphConfigSchema.safeParse({
      screenSizes: [],
      urlAnalysisNormalizeRules: [
        { matcher: { path: { prefixx: '/a' } }, transform: {} },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'urlAnalysisNormalizeRules.0.matcher.path',
    );
  });
});

describe('ConditionSchema', () => {
  it.each([
    ['a bare string, meaning exact', 'nav-home'],
    ['a list of strings, meaning exact any-of', ['nav-home', 'nav-about']],
    ['exact', { exact: 'nav-home' }],
    ['prefix', { prefix: '/product/' }],
    ['suffix', { suffix: '.pdf' }],
    ['contains', { contains: ['footer', 'header'] }],
    ['regex', { regex: '^/p/\\d+$' }],
    ['a list of regexes', { regex: ['^/p/', '^/q/'] }],
    ['isSet', { isSet: true }],
    ['not', { not: { contains: 'admin' } }],
    ['any', { any: ['/a', { prefix: '/b/' }] }],
    ['all', { all: [{ prefix: '/b/' }, { not: { contains: 'admin' } }] }],
    [
      'nesting',
      { any: [{ all: [{ not: 'x' }, { prefix: 'y' }] }, { regex: '^z' }] },
    ],
  ])('parses %s', (_label, condition) => {
    expect(ConditionSchema.safeParse(condition).success).toBe(true);
  });

  // The reason every branch is a `strictObject`: a typo has to fail rather than
  // parse as the half of the object that happens to be spelled right.
  it.each([
    ['a misspelled operator', { prefixx: '/a' }],
    ['an extra key alongside a good one', { prefix: '/a', sufix: '/b' }],
    ['two operators at once', { prefix: '/a', suffix: '/b' }],
    ['isSet: false', { isSet: false }],
    ['a non-string value', { prefix: 42 }],
    ['an empty object', {}],
  ])('rejects %s', (_label, condition) => {
    expect(ConditionSchema.safeParse(condition).success).toBe(false);
  });
});

describe('QueryParamConditionSchema', () => {
  it.each([
    ['a key on its own, meaning the param is present', { key: 'utm_source' }],
    ['a key and a value', { key: 'v', value: 'b' }],
    [
      'conditions on both sides',
      { key: { prefix: 'utm_' }, value: ['a', 'b'] },
    ],
    ['all', { all: [{ key: 'a', value: '1' }, { key: 'b' }] }],
    ['any', { any: [{ key: 'a' }, { key: 'b' }] }],
    [
      'not, meaning no param satisfies it',
      { not: { key: { prefix: 'utm_' } } },
    ],
    [
      'nesting',
      {
        all: [
          { key: 'checkout', value: ['stripe', 'paypal'] },
          { not: { any: [{ key: 'debug' }, { key: { prefix: 'utm_' } }] } },
        ],
      },
    ],
  ])('parses %s', (_label, condition) => {
    expect(QueryParamConditionSchema.safeParse(condition).success).toBe(true);
  });

  it.each([
    ['a value with no key', { value: 'b' }],
    ['a misspelled key field', { keys: 'v' }],
    ['an extra key', { key: 'v', value: 'b', op: 'eq' }],
    ['an empty object', {}],
  ])('rejects %s', (_label, condition) => {
    expect(QueryParamConditionSchema.safeParse(condition).success).toBe(false);
  });
});
