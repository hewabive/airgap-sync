import { defineConfig } from 'tsup';

export default defineConfig([
  {
    clean: true,
    dts: true,
    entry: ['src/index.ts'],
    format: ['esm'],
    sourcemap: true,
    target: 'node22',
  },
  {
    clean: false,
    dts: false,
    entry: ['src/cli.ts'],
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    shims: true,
    sourcemap: true,
    splitting: false,
    target: 'node22',
  },
]);
