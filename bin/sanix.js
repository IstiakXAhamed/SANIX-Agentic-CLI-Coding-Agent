#!/usr/bin/env node
/**
 * SANIX — Global entry point wrapper.
 *
 * This file lives at the repository root so that Node's ESM module resolver
 * can find all dependencies in the root `node_modules/`. The actual CLI
 * logic is in `packages/cli/dist/main.js`.
 *
 * When a user runs `sanix` (via npm link or npm install -g), Node executes
 * this file. We dynamically import the real entry point and call its
 * `main()` function directly (bypassing the `isMainModule` check which
 * doesn't work through a wrapper).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The real CLI entry point is one level up in packages/cli/dist/main.js.
const cliEntry = join(__dirname, '..', 'packages', 'cli', 'dist', 'main.js');

try {
  const mod = await import(cliEntry);
  // The CLI exports a `main()` function. Call it with process.argv.
  if (typeof mod.main === 'function') {
    await mod.main(process.argv);
  } else {
    console.error('✗ SANIX CLI entry point does not export main().');
    process.exit(1);
  }
} catch (err) {
  if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
    console.error('\n  ✗ SANIX is not built yet.');
    console.error('    Run: cd ' + join(__dirname, '..') + ' && npm install && npm run build\n');
    process.exit(1);
  }
  throw err;
}
