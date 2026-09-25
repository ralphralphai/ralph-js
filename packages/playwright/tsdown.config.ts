import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/reporter.ts'],
  format: ['cjs', 'esm'],
  dts: { cjsReexport: true },
  sourcemap: true,
  target: 'node20.19',
  deps: {
    neverBundle: [
      '@playwright/test',
      '@playwright/test/reporter',
      '@playwright/test/package.json',
      '@ralphralphai/config',
      '@ralphralphai/config/zod',
      '@ralphralphai/config/package.json',
    ],
  },
  outExtensions: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.mjs',
    dts: format === 'cjs' ? '.d.cts' : '.d.mts',
  }),
});
