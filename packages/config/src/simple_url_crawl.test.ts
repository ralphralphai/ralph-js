import { describe, expect, it } from 'vitest';

import type { WebRalphConfig } from '@/index';
import { WebRalphConfigSchema } from '@/ralph';
import { SimpleUrlCrawlRuleSchema } from '@/simple_url_crawl';

describe('simpleUrlCrawlRules', () => {
  it('parses a scenario with a name, start URL, normalize and ignore rules', () => {
    const config: WebRalphConfig = {
      screenSizes: [],
      simpleUrlCrawlRules: [
        {
          scenario: {
            name: 'Product listing',
            startUrl: 'https://dev.web.halfmore.co/products',
            urlNormalizeRules: [
              {
                matcher: { path: { prefix: '/product/' } },
                transform: { updatedPath: '/product/:id' },
              },
            ],
            dataFollowIgnoreRules: [
              { matcher: {}, ignore: { prefix: 'nav-' } },
            ],
          },
        },
        { scenario: { startUrl: 'http://localhost:3000' } },
      ],
    };

    expect(WebRalphConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    ['no start URL', { scenario: { name: 'Home' } }],
    ['a relative start URL', { scenario: { startUrl: '/products' } }],
    ['an empty name', { scenario: { name: '', startUrl: 'https://a.co' } }],
    ['a list of start URLs', { scenario: { startUrl: ['https://a.co'] } }],
    [
      'a misspelled scenario field',
      { scenario: { startUrl: 'https://a.co', normalizeRules: [] } },
    ],
    ['the scenario fields unwrapped', { startUrl: 'https://a.co' }],
    [
      'an ignore rule with no matcher',
      {
        scenario: {
          startUrl: 'https://a.co',
          dataFollowIgnoreRules: [{ ignore: 'nav-home' }],
        },
      },
    ],
  ])('rejects a rule with %s', (_label, rule) => {
    expect(SimpleUrlCrawlRuleSchema.safeParse(rule).success).toBe(false);
  });

  it.each([
    'urlsToCrawl',
    'urlCrawlNormalizeRules',
    'crawlRules',
    'dataFollowIgnoreRules',
  ])('rejects the removed `%s` field', (field) => {
    expect(
      WebRalphConfigSchema.safeParse({ screenSizes: [], [field]: [] }).success,
    ).toBe(false);
  });
});
