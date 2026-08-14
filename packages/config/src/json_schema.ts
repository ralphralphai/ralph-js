import { z } from 'zod';

import { WebRalphConfigSchema } from '@/ralph';

// Where `pnpm generate` writes the schema, relative to the package root, and
// where the published tarball carries it.
export const JSON_SCHEMA_FILE = 'schema/ralph.schema.json';

// Where `pnpm generate` writes the types generated from that schema.
export const GENERATED_TYPES_FILE = 'src/generated/config.ts';

// The canonical URL of the generated schema, so an editor can be pointed at it
// without installing this package.
export const JSON_SCHEMA_URL = `https://raw.githubusercontent.com/ralphralphai/ralph-js/main/packages/config/${JSON_SCHEMA_FILE}`;

/**
 * The JSON Schema of `WebRalphConfigSchema`, as `schema/ralph.schema.json` ships
 * it and as the published types are generated from it.
 *
 * Draft 7 rather than 2020-12: it is what VS Code's and JetBrains' JSON / JSONC
 * validators support most completely, and this schema uses nothing newer.
 */
export function buildJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(WebRalphConfigSchema, {
    target: 'draft-7',
    io: 'input',
  });
}

/**
 * The exact bytes `JSON_SCHEMA_FILE` holds.
 *
 * The `$id` is added here rather than in `buildJsonSchema`, because the type
 * generator names the root type after it when it is present.
 */
export function serializeJsonSchema(): string {
  const schema = { ...buildJsonSchema(), $id: JSON_SCHEMA_URL };

  return `${JSON.stringify(schema, null, 2)}\n`;
}
