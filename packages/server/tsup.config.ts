import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'mcp/index': 'src/mcp/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  external: [
    '@sanix/core',
    '@sanix/providers',
    '@sanix/tools',
    '@sanix/config',
    '@sanix/auth',
    '@sanix/share',
    '@modelcontextprotocol/sdk',
  ],
});
