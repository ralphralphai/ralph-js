import { defineConfig } from 'tsdown';

export default defineConfig({
  // Two entry points on purpose: `index` is the type-only contract, which must
  // stay free of runtime code and of zod, and `zod` is the opt-in runtime
  // validation that imports it.
  entry: ['src/index.ts', 'src/zod.ts'],
  format: ['cjs', 'esm'],
  // The runtime /zod entry needs real value declarations for CommonJS. The
  // re-export shim is type-only, so a .cts consumer could not call the schemas.
  dts: { cjsReexport: false },
  sourcemap: true,
  target: false,
  outExtensions: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.mjs',
    dts: format === 'cjs' ? '.d.cts' : '.d.mts',
  }),
});
