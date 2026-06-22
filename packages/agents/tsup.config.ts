import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,  // DTS disabled — tsup can't resolve protected methods from BaseAgent across files
  clean: true,
  sourcemap: true,
  target: 'es2022',
  platform: 'node',
});
