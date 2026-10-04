import type {
  ConditionsDeclaration,
  NodeConditions,
  RecordedTags,
  TagConditions,
  TagDeclaration,
} from './types';

const declared = (declaration: TagDeclaration = {}): TagConditions => {
  const conditions: TagConditions = {};
  for (const [key, value] of Object.entries(declaration)) {
    if (value === undefined) {
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    conditions[key] = [...new Set(values.map((item) => item ?? null))];
  }
  return conditions;
};

/** A declaration as sets: a scalar is a one-element set, `undefined` is `null`. */
export function declaredConditions(
  declaration: ConditionsDeclaration,
): NodeConditions {
  return {
    visitorTags: declared(declaration.visitorTags),
    pageTags: declared(declaration.pageTags),
  };
}

/** Later declarations win per key, as later `tagPage` calls do in the app. */
export function mergeConditions(layers: NodeConditions[]): NodeConditions {
  return {
    visitorTags: Object.assign({}, ...layers.map((layer) => layer.visitorTags)),
    pageTags: Object.assign({}, ...layers.map((layer) => layer.pageTags)),
  };
}

/**
 * Declared keys the app's tracker disagrees with, as `visitorTags.plan`. A
 * node's conditions come from the test alone, so this is the only check that
 * production events will carry the tags its conditions name: a key the app
 * never sets, or sets under another name, leaves the node without traffic.
 */
export function mismatchesOf(
  declared: NodeConditions,
  reported: RecordedTags | undefined,
): string[] {
  if (reported === undefined) {
    return [];
  }
  const mismatches: string[] = [];
  for (const kind of ['visitorTags', 'pageTags'] as const) {
    for (const [key, allowed] of Object.entries(declared[kind] ?? {})) {
      if (!allowed.includes(reported[kind][key] ?? null)) {
        mismatches.push(`${kind}.${key}`);
      }
    }
  }
  return mismatches.sort();
}

/** Absent kinds are left out, so an unconditional node has no conditions. */
export function compactConditions(
  conditions: NodeConditions,
): NodeConditions | undefined {
  const compact: NodeConditions = {};
  for (const kind of ['visitorTags', 'pageTags'] as const) {
    if (Object.keys(conditions[kind] ?? {}).length > 0) {
      compact[kind] = conditions[kind];
    }
  }
  return Object.keys(compact).length === 0 ? undefined : compact;
}

/**
 * The node a state belongs to, as a string, whatever the order of keys or
 * values. Equal keys are one node, so a tag change that leaves this alone
 * records nothing.
 */
export function nodeKey(conditions: NodeConditions): string {
  const sorted = (tags: TagConditions = {}) =>
    Object.entries(tags)
      .map(
        ([key, values]) =>
          [key, values.map((value) => JSON.stringify(value)).sort()] as const,
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    sorted(conditions.visitorTags),
    sorted(conditions.pageTags),
  ]);
}
