import { describe, expect, it } from 'vitest';

import { CrawlRuleSchema, CrawlStepSchema } from '@/crawl';
import type { WebRalphConfig } from '@/index';
import { WebRalphConfigSchema } from '@/ralph';

describe('crawl rules', () => {
  it('parses shorthand steps through the public config contract', () => {
    const config: WebRalphConfig = {
      screenSizes: [],
      crawlRules: [
        {
          at: { path: '/login' },
          sequences: [{ name: 'submit', steps: [{ click: 'submit' }] }],
          scenarios: [
            {
              name: 'Sign in',
              steps: [
                { fill: 'email', value: { var: 'email' } },
                { fill: 'password', value: 'example' },
                { run: 'submit' },
                { waitFor: 'status', expectedValue: 'ready', timeoutMs: 5000 },
                { fetchUrl: '/session', body: {}, saveAs: 'session' },
              ],
            },
          ],
        },
      ],
    };
    expect(WebRalphConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    { click: 'submit', run: 'login' },
    { click: 'submit', timeout: 1000 },
    { fill: 'email', value: { var: 'email', fallback: 'example' } },
    { id: 'login' },
  ])('rejects ambiguous or misspelled steps: %j', (step) => {
    expect(CrawlStepSchema.safeParse(step).success).toBe(false);
  });

  it('rejects misspelled optional rule fields instead of discarding scenarios', () => {
    expect(
      CrawlRuleSchema.safeParse({
        at: {},
        scenario: [{ steps: [{ click: 'submit' }] }],
      }).success,
    ).toBe(false);
  });

  it('defaults a wait timeout and rejects invalid durations', () => {
    const step = { waitFor: 'status', expectedValue: 'ready' };
    expect(CrawlStepSchema.parse(step)).toEqual({ ...step, timeoutMs: 3000 });
    for (const timeoutMs of [-1, 1.5, Infinity]) {
      expect(CrawlStepSchema.safeParse({ ...step, timeoutMs }).success).toBe(
        false,
      );
    }
  });
});
