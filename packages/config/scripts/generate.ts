// Turns the zod schemas in `src` into the two artifacts this package is made of:
//
//   schema/ralph.schema.json  the JSON Schema a `ralph.jsonc` points at
//   src/generated/config.ts   the types `src/index.ts` publishes
//
// Run by `pnpm generate`, which `pnpm build` and `pnpm check` run first, so
// neither the published types nor the published schema can lag the schemas they
// come from. Going through JSON Schema rather than `z.infer` is what keeps zod
// out of the published `.d.ts`: consumers get plain structural types, and no
// dependency.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { compile } from 'json-schema-to-typescript';

import {
  buildJsonSchema,
  GENERATED_TYPES_FILE,
  JSON_SCHEMA_FILE,
  serializeJsonSchema,
} from '@/json_schema';

// pnpm runs a package's scripts from the package root.
const write = (relativePath: string, contents: string) => {
  const outPath = join(process.cwd(), relativePath);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, contents, 'utf8');

  console.log(`Wrote ${relativePath}`);
};

const generateTypes = async () =>
  compile(buildJsonSchema(), 'WebRalphConfig', {
    // Without this the generator adds an `[k: string]: unknown` index signature
    // to every object, which would let any misspelled rule typecheck.
    additionalProperties: false,
    bannerComment: `/**
 * Generated from the zod schemas in \`src\` by \`pnpm generate\`. Do not edit.
 *
 * The published contract: plain types, no runtime code, no dependencies.
 */`,
    style: { singleQuote: true },
  });

const main = async () => {
  write(JSON_SCHEMA_FILE, serializeJsonSchema());
  write(GENERATED_TYPES_FILE, await generateTypes());
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
