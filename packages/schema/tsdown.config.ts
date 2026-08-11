import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: { cjsReexport: true },
  sourcemap: true,
  target: false,
  outExtensions: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.mjs',
    dts: format === 'cjs' ? '.d.cts' : '.d.mts',
  }),
});
