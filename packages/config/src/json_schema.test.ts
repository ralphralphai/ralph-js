import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildJsonSchema,
  JSON_SCHEMA_FILE,
  serializeJsonSchema,
} from '@/json_schema';

const committed = () =>
  readFileSync(
    path.resolve(import.meta.dirname, '..', JSON_SCHEMA_FILE),
    'utf8',
  );

describe('the generated JSON Schema', () => {
  // The committed file is what a `ralph.jsonc` points at, so it has to match the
  // zod schemas it came from. `pnpm generate` fixes this failure.
  it('matches the committed schema/ralph.schema.json', () => {
    expect(committed()).toBe(serializeJsonSchema());
  });

  it('requires screenSizes and nothing else', () => {
    expect(buildJsonSchema().required).toEqual(['screenSizes']);
  });

  // `Condition` and `QueryParamCondition` nest inside themselves, so each has
  // to come out as a reusable definition rather than an inlined - and therefore
  // truncated - tree.
  it.each(['Condition', 'QueryParamCondition'])(
    'emits the recursive %s as a draft-7 definition',
    (name) => {
      const definitions = buildJsonSchema().definitions as Record<
        string,
        unknown
      >;

      expect(Object.keys(definitions)).toContain(name);
      expect(JSON.stringify(definitions[name])).toContain(
        `#/definitions/${name}`,
      );
    },
  );
});
