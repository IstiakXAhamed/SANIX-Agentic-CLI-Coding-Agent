import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/strategies/index.ts', 'src/templates/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  external: ['@sanix/*'],
});
