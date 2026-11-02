import { describe, expect, it } from 'vitest';

import { ConditionSchema } from '@/condition';
import { HostOverrideRuleSchema } from '@/host_override';
import type { WebRalphConfig } from '@/index';
import { QueryParamConditionSchema } from '@/query_param';
import { WebRalphConfigSchema } from '@/ralph';
import { screenDeviceOf } from '@/screen_size';

describe('WebRalphConfigSchema', () => {
  // The published types are generated from this schema, so the two agree by
  // construction. This is the check that the generation step actually ran and
  // that both ends still describe the same config: it fails to compile if the
  // type drifts, and fails to parse if the schema does.
  it('parses a value that satisfies the published WebRalphConfig type', () => {
    const config: WebRalphConfig = {
      simpleUrlCrawlRules: [
        { scenario: { name: 'Home', startUrl: 'https://example.com' } },
      ],
      screenSizes: [{ width: 1280, height: 720 }],
      hostOverrides: [
        {
          matcher: { host: 'dev.web.example.com' },
          updatedHost: 'example.com',
        },
      ],
      graphUrlNormalizeRules: [
        {
          matcher: { path: { prefix: '/product/' } },
          transform: { updatedPath: '/product/:id' },
        },
      ],
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
      WebRalphConfigSchema.safeParse({ screenSizes: [], urlsToCrawl: [] })
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

describe('hostOverrides', () => {
  // The case it exists for: the crawler visits the dev host, the tracker
  // reports from the production one, and the graph has to record the latter
  // for the two to join.
  it('parses the dev-host-to-production-host rewrite', () => {
    const result = WebRalphConfigSchema.safeParse({
      screenSizes: [],
      simpleUrlCrawlRules: [
        { scenario: { startUrl: 'https://dev.web.halfmore.co' } },
      ],
      hostOverrides: [
        {
          matcher: { host: 'dev.web.halfmore.co' },
          updatedHost: 'halfmore.co',
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a config that declares none', () => {
    expect(WebRalphConfigSchema.safeParse({ screenSizes: [] }).success).toBe(
      true,
    );
  });

  it('names the offending path when a rule is misspelled', () => {
    const result = WebRalphConfigSchema.safeParse({
      screenSizes: [],
      hostOverrides: [{ matcher: {}, updatedhost: 'halfmore.co' }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'hostOverrides.0',
    );
  });
});

describe('graphUrlNormalizeRules', () => {
  // The case it exists for: ids in recorded URLs collapse onto one graph node,
  // whether a Playwright test or a simple crawl recorded them.
  it('parses an id-collapsing rule', () => {
    const result = WebRalphConfigSchema.safeParse({
      screenSizes: [],
      graphUrlNormalizeRules: [
        {
          matcher: { path: { regex: '^/order/[0-9a-f-]+$' } },
          transform: {
            updatedPath: '/order/:id',
            queryParams: [{ remove: 'session' }],
          },
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('names the offending path when a rule is misspelled', () => {
    const result = WebRalphConfigSchema.safeParse({
      screenSizes: [],
      graphUrlNormalizeRules: [
        { matcher: {}, transform: { updatedpath: '/order/:id' } },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'graphUrlNormalizeRules.0.transform',
    );
  });
});

describe('HostOverrideRuleSchema', () => {
  it.each([
    ['an exact host', { host: 'dev.web.halfmore.co' }],
    ['a host carrying a port', { host: 'localhost:3000' }],
    [
      'a list of hosts',
      { host: ['dev.web.halfmore.co', 'staging.halfmore.co'] },
    ],
    ['a host condition', { host: { prefix: 'dev.' } }],
    [
      'a regex over hosts',
      { host: { regex: '^dev\\.[a-z]+\\.halfmore\\.co$' } },
    ],
    ['an empty matcher, meaning every crawled URL', {}],
    [
      'a host narrowed by path',
      { host: { suffix: '.halfmore.co' }, path: { prefix: '/product/' } },
    ],
    [
      'a host narrowed by query params',
      { host: 'dev.web.halfmore.co', queryParams: { key: 'preview' } },
    ],
  ])('parses a rule matching %s', (_label, matcher) => {
    expect(
      HostOverrideRuleSchema.safeParse({ matcher, updatedHost: 'halfmore.co' })
        .success,
    ).toBe(true);
  });

  it.each([
    ['no updatedHost', { matcher: { host: 'dev.halfmore.co' } }],
    ['no matcher', { updatedHost: 'halfmore.co' }],
    [
      'a transform borrowed from a normalize rule',
      { matcher: {}, transform: { updatedPath: '/' } },
    ],
    [
      'a misspelled matcher field',
      { matcher: { hostt: 'dev.halfmore.co' }, updatedHost: 'halfmore.co' },
    ],
    ['a non-string updatedHost', { matcher: {}, updatedHost: ['halfmore.co'] }],
  ])('rejects a rule with %s', (_label, rule) => {
    expect(HostOverrideRuleSchema.safeParse(rule).success).toBe(false);
  });
});

describe('UrlRuleMatcher host', () => {
  // `host` lands on the shared matcher, so every rule list can scope to a
  // subdomain, not just `hostOverrides`.
  it('scopes a normalize rule to one host', () => {
    const result = WebRalphConfigSchema.safeParse({
      screenSizes: [],
      urlAnalysisNormalizeRules: [
        {
          matcher: { host: 'halfmore.co', path: { prefix: '/product/' } },
          transform: { updatedPath: '/product/:id' },
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe('screenSizes bands', () => {
  const parse = (screenSizes: unknown[]) => {
    return WebRalphConfigSchema.safeParse({ screenSizes });
  };

  const messages = (screenSizes: unknown[]) => {
    return (
      parse(screenSizes).error?.issues.map((issue) => {
        return issue.message;
      }) ?? []
    );
  };

  it('accepts sizes without bands, which fall back to the nearest width', () => {
    expect(
      parse([
        { width: 402, height: 874 },
        { width: 1280, height: 720 },
      ]).success,
    ).toBe(true);
  });

  it('accepts adjacent open-ended bands with device tags', () => {
    expect(
      parse([
        { width: 402, height: 874, maxWidth: 767, device: 'mobile' },
        { width: 1280, height: 720, minWidth: 768, device: 'desktop' },
      ]).success,
    ).toBe(true);
  });

  it('accepts gaps between bands', () => {
    expect(
      parse([
        { width: 402, height: 874, maxWidth: 500 },
        { width: 1280, height: 720, minWidth: 1024 },
      ]).success,
    ).toBe(true);
  });

  it('accepts a lone size with an unbounded band', () => {
    expect(
      parse([{ width: 1280, height: 720, device: 'desktop' }]).success,
    ).toBe(true);
  });

  it('rejects bands that share a width, since both bounds are inclusive', () => {
    expect(
      messages([
        { width: 402, height: 874, maxWidth: 768 },
        { width: 1280, height: 720, minWidth: 768 },
      ]),
    ).toEqual([expect.stringContaining('1280x720 overlaps 402x874')]);
  });

  it('rejects a size without bounds next to banded ones, since it covers every width', () => {
    expect(
      messages([
        { width: 402, height: 874, maxWidth: 767 },
        { width: 1280, height: 720 },
      ]),
    ).toEqual([expect.stringContaining('1280x720 overlaps 402x874')]);
  });

  it('rejects two heights at one width, which a width band cannot tell apart', () => {
    expect(
      messages([
        { width: 390, height: 844, maxWidth: 500 },
        { width: 390, height: 664, maxWidth: 500 },
      ]),
    ).toEqual([expect.stringContaining('390x664 overlaps 390x844')]);
  });

  it('rejects a size outside its own band', () => {
    expect(messages([{ width: 1280, height: 720, maxWidth: 767 }])).toEqual([
      expect.stringContaining('outside its own band'),
    ]);
  });

  it('rejects minWidth above maxWidth', () => {
    expect(
      messages([{ width: 800, height: 600, minWidth: 900, maxWidth: 700 }]),
    ).toEqual([expect.stringContaining('exceeds maxWidth')]);
  });

  it.each([
    ['a fractional bound', { width: 800, height: 600, maxWidth: 800.5 }],
    ['a misspelled bound', { width: 800, height: 600, maxWdth: 900 }],
    ['an unknown device', { width: 800, height: 600, device: 'tv' }],
  ])('rejects %s', (_label, size) => {
    expect(parse([size]).success).toBe(false);
  });
});

describe('screenDeviceOf', () => {
  it.each([
    [639, 'mobile'],
    [640, 'tablet'],
    [1023, 'tablet'],
    [1024, 'desktop'],
  ])('guesses a %ipx wide size without a device as %s', (width, device) => {
    expect(screenDeviceOf({ width })).toBe(device);
  });

  it('keeps the device a size declares', () => {
    expect(screenDeviceOf({ width: 1280, device: 'tablet' })).toBe('tablet');
  });
});
