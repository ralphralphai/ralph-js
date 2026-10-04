import { describe, expect, it } from 'vitest';

import {
  compactConditions,
  declaredConditions,
  mergeConditions,
  mismatchesOf,
  nodeKey,
} from './conditions';

describe('declaredConditions', () => {
  it('turns scalars into one-element sets and undefined into null', () => {
    expect(
      declaredConditions({
        visitorTags: { plan: ['pro', 'enterprise'], skipped: undefined },
        pageTags: { dialog: [undefined, 'shipping'], step: 2 },
      }),
    ).toEqual({
      visitorTags: { plan: ['pro', 'enterprise'] },
      pageTags: { dialog: [null, 'shipping'], step: [2] },
    });
  });
});

describe('mergeConditions', () => {
  it('lets a later declaration win per key, kind by kind', () => {
    expect(
      mergeConditions([
        { visitorTags: { plan: ['pro'] }, pageTags: { dialog: ['a'] } },
        { visitorTags: {}, pageTags: { dialog: ['b'] } },
      ]),
    ).toEqual({ visitorTags: { plan: ['pro'] }, pageTags: { dialog: ['b'] } });
  });
});

describe('mismatchesOf', () => {
  const reported = {
    visitorTags: { plan: 'trial', account: 'a1' },
    pageTags: { dialog: 'shipping' },
  };

  it('accepts reported values inside the declared sets', () => {
    expect(
      mismatchesOf(
        { visitorTags: { plan: ['free', 'trial'] }, pageTags: {} },
        reported,
      ),
    ).toEqual([]);
  });

  it('ignores what the app reports for keys the test did not declare', () => {
    expect(mismatchesOf({}, reported)).toEqual([]);
  });

  it('flags a reported value outside a declared set, in either kind', () => {
    expect(
      mismatchesOf(
        { visitorTags: { plan: ['pro'] }, pageTags: { dialog: ['other'] } },
        reported,
      ),
    ).toEqual(['pageTags.dialog', 'visitorTags.plan']);
  });

  it('flags a declared key the app reports absent, unless absence is declared', () => {
    const none = { visitorTags: {}, pageTags: {} };
    expect(mismatchesOf({ visitorTags: { experiment: ['a'] } }, none)).toEqual([
      'visitorTags.experiment',
    ]);
    expect(
      mismatchesOf({ visitorTags: { experiment: [null, 'a'] } }, none),
    ).toEqual([]);
  });

  it('checks nothing when the page runs no tracker', () => {
    expect(mismatchesOf({ visitorTags: { plan: ['pro'] } }, undefined)).toEqual(
      [],
    );
  });
});

describe('compactConditions', () => {
  it('drops empty kinds, and everything for an unconditional node', () => {
    expect(compactConditions({ visitorTags: {}, pageTags: {} })).toBe(
      undefined,
    );
    expect(
      compactConditions({ visitorTags: {}, pageTags: { dialog: ['x'] } }),
    ).toEqual({ pageTags: { dialog: ['x'] } });
  });
});

describe('nodeKey', () => {
  it('ignores the order of keys and values', () => {
    expect(nodeKey({ visitorTags: { a: ['x', 'y'] }, pageTags: {} })).toBe(
      nodeKey({ visitorTags: { a: ['y', 'x'] } }),
    );
  });

  it('keeps the two kinds apart', () => {
    expect(nodeKey({ visitorTags: { a: ['x'] } })).not.toBe(
      nodeKey({ pageTags: { a: ['x'] } }),
    );
  });
});
