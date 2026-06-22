#!/usr/bin/env node
/**
 * @file build-cli.js
 * @description Builds the SANIX CLI and bundles it into the VS Code extension
 *              for self-contained distribution.
 *
 * This script auto-detects the directory layout:
 *
 *   Layout A — Standalone extension (development):
 *     <extension-root>/
 *     ├── bin/                ← bundled runtime target (cli/ is created here)
 *     ├── sanix-v1.0.0/       ← CLI monorepo (git clone or symlink)
 *     │   ├── packages/
 *     │   ├── package.json
 *     │   └── node_modules/
 *     └── scripts/
 *         └── build-cli.js     ← this file
 *
 *   Layout B — Inside CLI monorepo (CI/CD or unified repo):
 *     <monorepo-root>/
 *     ├── packages/
 *     │   └── vscode/
 *     │       ├── bin/         ← bundled runtime target
 *     │       └── scripts/
 *     │           └── build-cli.js
 *     ├── package.json
 *     └── node_modules/
 *
 * Usage:
 *   node scripts/build-cli.js          # Build + bundle (production)
 *   node scripts/build-cli.js --skip-build  # Bundle only (use existing dist)
 *
 * @packageDocumentation
 */

import { execSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Paths ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

// Auto-detect layout: inside monorepo (packages/vscode/) or standalone
const MONOREPO_CANDIDATE = resolve(__dirname, "../../..");
const MONOREPO_PKG = join(MONOREPO_CANDIDATE, "package.json");
const isInsideMonorepo =
  existsSync(MONOREPO_PKG) &&
  (() => {
    try {
      const json = JSON.parse(readFileSync(MONOREPO_PKG, "utf-8"));
      return !!json.workspaces;
    } catch { return false; }
  })();

const CLI_SRC = isInsideMonorepo ? MONOREPO_CANDIDATE : join(ROOT, "sanix-v1.0.0");
const CLI_DIST = join(CLI_SRC, "packages");
const TARGET = join(ROOT, "bin", "cli");

const SKIP_BUILD = process.argv.includes("--skip-build");

// Native modules that are platform-specific and cannot be bundled by tsup.
// These must be copied from the installed node_modules as-is.
const NATIVE_MODULES = [
  "better-sqlite3",
  "@lancedb/lancedb",
  "@xenova/transformers",
  "playwright",
];

// Monorepo workspace packages (all 42). tsup externalises these as bare
// specifiers, so Node resolves them via the workspace links in node_modules.
const WORKSPACE_PACKAGES = [
  "agents",
  "audit",
  "auth",
  "autotool",
  "bench",
  "browser",
  "cli",
  "completions",
  "compressor",
  "config",
  "core",
  "dashboard",
  "desktop",
  "distributed",
  "docai",
  "federated",
  "intel",
  "knowledge",
  "marketplace",
  "memory-v2",
  "multiagent",
  "nlsql",
  "observe",
  "optimizer",
  "perf",
  "polish",
  "prbot",
  "providers",
  "rag",
  "sandbox",
  "self-improve",
  "semantic-cache",
  "server",
  "share",
  "telemetry",
  "timetravel",
  "token-slim",
  "tools",
  "tui",
  "vault",
  "voice",
  "workflows",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, cwd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function log(label, msg) {
  console.log(`[${label}] ${msg}`);
}

/** Copy a directory recursively, removing destination first. */
function copyDir(src, dest, filter = null) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (filter && !filter(srcPath)) continue;

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      try {
        cpSync(srcPath, destPath, { recursive: true, dereference: true });
      } catch (err) {
        log("WARN", `Failed to copy ${srcPath}: ${err.message}`);
      }
    }
  }
}

/** Get the production dependency tree for a given package.json. */
function getProductionDeps(pkgJsonPath) {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  return Object.keys(pkg.dependencies || {});
}

// ─── Step 0: Validate ───────────────────────────────────────────────────────

if (!existsSync(join(CLI_SRC, "package.json"))) {
  console.error(
    `✗ SANIX CLI source not found at ${CLI_SRC}\n` +
      "  Expected the sanix-v1.0.0 directory to contain the SANIX monorepo.",
  );
  process.exit(1);
}

log("BUILD", `CLI source: ${CLI_SRC}`);
log("BUILD", `Target: ${TARGET}`);

// ─── Step 1: Install and Build the CLI ──────────────────────────────────────

if (!SKIP_BUILD) {
  if (!existsSync(join(CLI_SRC, "node_modules"))) {
    log("BUILD", "Installing CLI dependencies…");
    run("npm install --ignore-scripts", CLI_SRC);
  } else {
    log("BUILD", "node_modules exists — skipping npm install");
  }

  log("BUILD", "Building SANIX CLI (turbo build — filtered to CLI + its deps)…");
  // Use --filter to build only @sanix/cli (+ @sanix/agents which is imported
  // but not a declared dependency) and their transitive dependencies.
  // This avoids building unrelated packages (desktop/Electron, dashboard, etc.)
  // that may fail independently.
  const cliDistEntry = join(CLI_DIST, "cli", "dist", "main.js");
  if (!existsSync(cliDistEntry)) {
    const localTurbo = join(CLI_SRC, "node_modules", "turbo", "bin", "turbo");
    const turboCmd = existsSync(localTurbo)
      ? `node ${localTurbo}`
      : "npx turbo";
    run(`${turboCmd} build --filter=@sanix/agents --filter=@sanix/cli`, CLI_SRC);
  } else {
    log("BUILD", "CLI build output exists — skipping turbo build");
  }

  log("BUILD", "Installing production dependencies only…");
  // We use --production to get only prod deps, which also runs
  // native module compilation (better-sqlite3, @lancedb/lancedb).
  // Only reinstall if production deps aren't already installed (avoids
  // ENOTEMPTY errors from npm trying to rename directories).
  if (!existsSync(join(CLI_SRC, "node_modules", ".package-lock.json"))) {
    run("npm install --production", CLI_SRC);
  } else {
    log("BUILD", "node_modules already has production deps — skipping npm install --production");
  }
} else {
  log("BUILD", "Skipping build (--skip-build) — using existing dist.");
  if (!existsSync(join(CLI_SRC, "node_modules"))) {
    console.error("✗ --skip-build but no node_modules found. Run without --skip-build first.");
    process.exit(1);
  }
}

// ─── Step 2: Verify Build Output ────────────────────────────────────────────

const cliDistEntry = join(CLI_DIST, "cli", "dist", "main.js");
if (!existsSync(cliDistEntry)) {
  console.error(
    `✗ CLI build output not found at ${cliDistEntry}\n` +
      "  The build may have failed. Check the above output for errors.",
  );
  process.exit(1);
}
log("BUILD", `CLI main entry verified: ${cliDistEntry}`);

// ─── Step 3: Prepare Target ─────────────────────────────────────────────────

log("BUILD", `Cleaning target: ${TARGET}`);
if (existsSync(TARGET)) rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });

// ─── Step 4: Copy Package Dist Outputs ──────────────────────────────────────

log("BUILD", "Copying package dist outputs…");
for (const pkgName of WORKSPACE_PACKAGES) {
  const pkgDist = join(CLI_DIST, pkgName, "dist");
  const targetDist = join(TARGET, "packages", pkgName, "dist");

  if (!existsSync(pkgDist)) {
    log("WARN", `No dist/ for @sanix/${pkgName} — skipping`);
    continue;
  }

  mkdirSync(targetDist, { recursive: true });
  copyDir(pkgDist, targetDist);

  // Also copy the package.json for module resolution
  const pkgJson = join(CLI_DIST, pkgName, "package.json");
  if (existsSync(pkgJson)) {
    copyFileSync(pkgJson, join(TARGET, "packages", pkgName, "package.json"));
  }

  log("BUILD", `  ✓ @sanix/${pkgName}`);
}

// ─── Step 5: Copy Production node_modules ───────────────────────────────────

log("BUILD", "Copying production node_modules…");

const srcNodeModules = join(CLI_SRC, "node_modules");
const targetNodeModules = join(TARGET, "node_modules");

if (!existsSync(srcNodeModules)) {
  console.error(`✗ node_modules not found at ${srcNodeModules}`);
  process.exit(1);
}

mkdirSync(targetNodeModules, { recursive: true });

// Read the top-level node_modules and copy only production deps
const rootPkgJson = join(CLI_SRC, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgJson, "utf-8"));
const prodDeps = new Set(Object.keys(rootPkg.dependencies || {}));

// Add workspace package names
for (const pkgName of WORKSPACE_PACKAGES) {
  prodDeps.add(`@sanix/${pkgName}`);
}

// Also copy transitive dependencies that prod deps need
// Strategy: copy everything that's NOT a devDependency of any workspace package
// For simplicity: copy all non-dev top-level deps + their transitive deps
const entries = readdirSync(srcNodeModules, { withFileTypes: true });
let copiedCount = 0;

for (const entry of entries) {
  const srcPath = join(srcNodeModules, entry.name);

  // Skip .cache, .bin, and similar
  if (entry.name.startsWith(".")) continue;
  if (entry.name === ".bin") continue;

  try {
    const destPath = join(targetNodeModules, entry.name);

    if (entry.isSymbolicLink()) {
      // Resolve workspace symlinks
      const real = realpathSync(srcPath);
      if (existsSync(real) && statSync(real).isDirectory()) {
        cpSync(real, destPath, { recursive: true, dereference: true });
      } else if (existsSync(real)) {
        copyFileSync(real, destPath);
      }
      copiedCount++;
    } else if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
      copiedCount++;
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath);
      copiedCount++;
    }
  } catch (err) {
    log("WARN", `Failed to copy node_modules/${entry.name}: ${err.message}`);
  }
}

log("BUILD", `  ✓ ${copiedCount} node_modules entries copied`);

// ─── Step 6: Prune unnecessary bloat ─────────────────────────────────────────
//
// The monorepo root node_modules contains packages from ALL 42 workspace
// packages (dashboard, desktop, etc.) that the CLI doesn't use.  These add
// hundreds of MB of unnecessary bloat.  Prune known-unnecessary packages.

const BLOAT_PACKAGES = [
  // Web framework (from @sanix/dashboard) — 200+ MB
  "next",
  "@next",
  // UI component libraries (from dashboard/desktop) — 50+ MB
  "lucide-react",
  "recharts",
  "@tanstack",
  "@floating-ui",
  "d3-array",
  "d3-scale",
  "d3-shape",
  "d3-path",
  "d3-time",
  "d3-color",
  "d3-interpolate",
  "d3-format",
  "d3-time-format",
  "d3-ease",
  "d3-hierarchy",
  "d3-sankey",
  "victory-vendor",
  // Browser-specific ONNX runtime (CLI uses onnxruntime-node) — 70 MB
  "onnxruntime-web",
  "onnxruntime-common",  // re-installed as transitive dep if needed
  // Image processing — 30+ MB, not needed for CLI operation
  "sharp",
  "@img",
  // SVG/icon processing
  "svg-parser",
  // Large testing/meta packages that end up as prod deps
  "playwright-core",
  // Playwright wrapper (only used in doctor.ts as a dynamic import to check version)
  "playwright",
  // Turbo repo — the native binary is only needed for build, not runtime
  "@turbo/darwin-arm64",
  "turbo",
  // Desktop app deps (Electron, builders) — 1+ GB, not needed by CLI
  "electron",
  "electron-builder",
  "electron-builder-squirrel-windows",
  "electron-publish",
  "electron-store",
  "electron-to-chromium",
  "app-builder-bin",
  "app-builder-lib",
  "7zip-bin",
  // Build tools (vite, tsup, etc. bundle at build time — not needed at runtime)
  "esbuild",
  "@esbuild",
  "typescript",
  "lightningcss",
  "lightningcss-darwin-arm64",
  "@tailwindcss",
  "@rollup",
  "rollup",
  "vite",
  // Linting / code-quality — only used during development
  "eslint",
  "@eslint",
  "@typescript-eslint",
  "eslint-plugin-react-hooks",
  "eslint-plugin-react",
  "eslint-plugin-import",
  "eslint-plugin-jsx-a11y",
  "axe-core",
  "hermes-parser",
  // UI frameworks (from dashboard/desktop) — not needed by CLI
  "react",
  "react-dom",
  "react-reconciler",
  "react-transition-group",
  "react-smooth",
  "framer-motion",
  "@radix-ui",
  "postcss",
  // Browser compatibility data — not needed by server-side CLI
  "caniuse-lite",
  // Build tool for native addons — not needed at runtime
  "node-gyp",
  // Electron types — not needed by CLI
  "@electron",
];

function removeBloat(dir) {
  let removed = 0;
  let removedBytes = 0;
  for (const name of BLOAT_PACKAGES) {
    const pkgPath = join(dir, name);
    if (!existsSync(pkgPath)) continue;
    const size = getSize(pkgPath);
    rmSync(pkgPath, { recursive: true, force: true });
    removed++;
    removedBytes += size;
    log("PRUNE", `  removed ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
  return { removed, removedBytes };
}

// Prune from top-level
const { removed, removedBytes } = removeBloat(targetNodeModules);

// Also prune from within @scope directories (e.g. @next lives in node_modules/@next)
const scopeDirs = readdirSync(targetNodeModules, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith("@"));
for (const scope of scopeDirs) {
  const scopePath = join(targetNodeModules, scope.name);
  const entries = readdirSync(scopePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && BLOAT_PACKAGES.includes(`@${scope.name}/${entry.name}`)) {
      const fullPath = join(scopePath, entry.name);
      const size = getSize(fullPath);
      rmSync(fullPath, { recursive: true, force: true });
      log("PRUNE", `  removed @${scope.name}/${entry.name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}

if (removed > 0) {
  const savedMB = (removedBytes / 1024 / 1024).toFixed(0);
  log("PRUNE", `Freed ~${savedMB} MB — ${removed} packages removed`);
}

// ─── Step 7: Prune cross-platform native binaries ────────────────────────────
//
// Native modules like onnxruntime-node and better-sqlite3 ship prebuilt
// binaries for 4-6 platforms.  We only need the one matching the current
// build host.  Keeping the others bloats the VSIX by ~80 MB.

const nativeBindings = {
  // onnxruntime-node: keep only the dir matching current platform
  // layout: bin/napi-v3/{platform}/{arch}/onnxruntime.*
  "onnxruntime-node": () => {
    const nmPath = join(targetNodeModules, "onnxruntime-node", "bin", "napi-v3");
    if (!existsSync(nmPath)) return 0;
    let removed = 0;
    for (const entry of readdirSync(nmPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Keep only directories matching current platform
      if (entry.name !== `${process.platform}`) {
        const full = join(nmPath, entry.name);
        const size = getSize(full);
        rmSync(full, { recursive: true, force: true });
        log("PRUNE", `  removed onnxruntime-node/${entry.name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
        removed++;
        continue;
      }
      // Within our platform dir, also prune arch subdirectories that don't match
      const platformDir = join(nmPath, entry.name);
      for (const archEntry of readdirSync(platformDir, { withFileTypes: true })) {
        if (!archEntry.isDirectory()) continue;
        if (archEntry.name !== `${process.arch}`) {
          const archFull = join(platformDir, archEntry.name);
          const archSize = getSize(archFull);
          rmSync(archFull, { recursive: true, force: true });
          log("PRUNE", `  removed onnxruntime-node/${entry.name}/${archEntry.name} (${(archSize / 1024 / 1024).toFixed(1)} MB)`);
          removed++;
        }
      }
    }
    return removed;
  },
  // lancedb: each platform variant is a separate npm package (@lancedb/lancedb-{platform})
  // Keep only the one for the current platform, remove the others.
  "@lancedb": () => {
    const scopePath = join(targetNodeModules, "@lancedb");
    if (!existsSync(scopePath)) return 0;
    const targetVariant = `lancedb-${process.platform}-${process.arch}`;
    let removed = 0;
    for (const entry of readdirSync(scopePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // @lancedb/lancedb is the meta-package; keep it.
      // @lancedb/lancedb-{platform}-{arch} are platform-specific — keep only ours.
      if (entry.name.startsWith("lancedb-") && entry.name !== targetVariant) {
        const full = join(scopePath, entry.name);
        const size = getSize(full);
        rmSync(full, { recursive: true, force: true });
        log("PRUNE", `  removed @lancedb/${entry.name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
        removed++;
      }
    }
    return removed;
  },
};

let nativeRemoved = 0;
for (const [pkg, fn] of Object.entries(nativeBindings)) {
  nativeRemoved += fn();
}
if (nativeRemoved > 0) {
  log("PRUNE", `Pruned ${nativeRemoved} cross-platform native binary sets`);
}

// ─── Step 8: Trim gpt-tokenizer to only needed format ─────────────────────
//
// gpt-tokenizer ships with 5 copies of its BPE rank data (src, esm, dist,
// cjs, data). CJS require uses gpt-tokenizer/cjs/main.js, so only
// cjs/ and data/ are needed. The others are ~10 MB raw waste.

const GPT_TOKENIZER_DIR = join(targetNodeModules, "gpt-tokenizer");
if (existsSync(GPT_TOKENIZER_DIR)) {
  for (const dir of ["src", "esm", "dist"]) {
    const full = join(GPT_TOKENIZER_DIR, dir);
    if (existsSync(full)) {
      rmSync(full, { recursive: true, force: true });
      log("PRUNE", `  removed gpt-tokenizer/${dir}`);
    }
  }
}

// ─── Step 9: Create package.json in target so imports resolve ───────────────

const targetPkgJson = join(TARGET, "package.json");
const cliPkgJson = JSON.parse(
  readFileSync(join(CLI_DIST, "cli", "package.json"), "utf-8"),
);

writeFileSync(
  targetPkgJson,
  JSON.stringify(
    {
      name: "sanix-bundled",
      version: "1.0.0",
      type: "module",
      private: true,
      dependencies: Object.fromEntries(
        Object.entries(rootPkg.dependencies || {}).filter(
          ([key]) => !key.startsWith("@types/"),
        ),
      ),
    },
    null,
    2,
  ),
);

// ─── Step 10: Set Executable Permissions ────────────────────────────────────

log("BUILD", "Setting bootstrap script permissions…");
const platformDirs = ["macos-arm64", "macos-x64", "linux-x64", "win-x64"];
for (const dir of platformDirs) {
  const bootstrap = join(ROOT, "bin", dir, "sanix");
  if (existsSync(bootstrap)) {
    chmodSync(bootstrap, 0o755);
  } else if (existsSync(bootstrap + ".exe")) {
    chmodSync(bootstrap + ".exe", 0o755);
  }
}
log("BUILD", "  ✓ Done");

// ─── Step 11: Summary ───────────────────────────────────────────────────────

function getSize(dir) {
  let total = 0;
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  }
  walk(dir);
  return total;
}

const targetSize = getSize(TARGET);
const targetMB = (targetSize / 1024 / 1024).toFixed(1);

log("BUILD", `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
log("BUILD", `  CLI bundled successfully!`);
log("BUILD", `  Target:   ${TARGET}`);
log("BUILD", `  Size:     ${targetMB} MB`);
log("BUILD", `  Platform: ${process.platform} ${process.arch}`);
log("BUILD", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

log("BUILD", "Next: Run `npm run package` to produce the VSIX.");
log(
  "BUILD",
  "      Run this script on each target platform (macOS ARM, macOS x64, Linux x64, Windows x64)\n" +
  "      and then merge the platform-specific native modules into extension/bin/cli/node_modules/.",
);
