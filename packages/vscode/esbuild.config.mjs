import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.argv.includes("--production");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [resolve(__dirname, "src/extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: resolve(__dirname, "dist/extension.js"),
  external: ["vscode"],
  sourcemap: isProd ? false : true,
  minify: isProd,
  logLevel: "info",
  loader: { ".ts": "ts" },
};

// Copy webview assets into dist/ on every build so the bundled extension ships them.
function copyWebviewAssets() {
  const outDir = resolve(__dirname, "dist/webview");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  for (const file of ["chat.html", "chat.css", "chat.js"]) {
    const src = resolve(__dirname, "webview", file);
    const dst = resolve(outDir, file);
    if (existsSync(src)) copyFileSync(src, dst);
  }
}

try {
  const result = await build(options);
  copyWebviewAssets();
  console.log(
    `[esbuild] build ${isProd ? "(production)" : "(dev)"} → dist/extension.js (${result.errors.length} errors, ${result.warnings.length} warnings)`,
  );
  if (result.errors.length > 0) process.exitCode = 1;
} catch (err) {
  console.error("[esbuild] fatal:", err);
  process.exitCode = 1;
}
