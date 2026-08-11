import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts'],
  format: ['cjs', 'esm'],
  dts: { cjsReexport: true },
  sourcemap: true,
  target: false,
  // `@ralphralphai/schema` is types plus a dependency-free encoder, so it is
  // inlined rather than left as a runtime import. That is what keeps the browser
  // bundle free of any runtime dependency. `react` stays external; it is a peer.
  external: ['react', 'react/jsx-runtime'],
  outExtensions: ({ format }) => ({
    js: format === 'cjs' ? '.cjs' : '.mjs',
    dts: format === 'cjs' ? '.d.cts' : '.d.mts',
  }),
});
