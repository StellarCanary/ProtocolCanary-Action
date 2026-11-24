// Bundles src/main.ts into a single dist/index.js the Action runs from
// directly, so consumers never run `npm install`/`npm run build` inside
// their own workflow (see CONTRIBUTING.md).
//
// esbuild, not @vercel/ncc: the pinned @actions/* packages (core 3.x,
// artifact 6.x) ship as ESM-only. ncc's webpack-based bundler cannot
// bundle an ESM-only dependency into a CommonJS `runs.using: node24`
// action (it emits a "Cannot find Module" stub at runtime); esbuild
// handles ESM-into-CJS interop correctly.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { BUILD_OPTIONS } from "./build-options.mjs";

await build(BUILD_OPTIONS);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(__dirname, "..", BUILD_OPTIONS.outfile);
const bundleBytes = fs.statSync(bundlePath).size;

const guardPath = path.resolve(__dirname, "../tests/fixtures/bundle-guard.json");
const fmtKB = (n) => `${(n / 1024).toFixed(1)} KiB`;

if (fs.existsSync(guardPath)) {
  const guard = JSON.parse(fs.readFileSync(guardPath, "utf8"));
  const budgetBytes = guard.sizeBudgetBytes;

  console.log(
    `Built ${BUILD_OPTIONS.outfile} — ${bundleBytes.toLocaleString()} bytes (${fmtKB(bundleBytes)}) / budget ${budgetBytes.toLocaleString()} bytes (${fmtKB(budgetBytes)})`,
  );

  if (bundleBytes > budgetBytes) {
    console.error(
      `\nBundle size budget exceeded: ${bundleBytes.toLocaleString()} bytes is ${(bundleBytes - budgetBytes).toLocaleString()} bytes over the ${budgetBytes.toLocaleString()}-byte budget.`,
    );
    console.error(
      `Raise bundle-guard.json sizeBudgetBytes deliberately, with a reason, when the bundle legitimately grows.`,
    );
    process.exit(1);
  }
} else {
  console.log(
    `Built ${BUILD_OPTIONS.outfile} — ${bundleBytes.toLocaleString()} bytes (${fmtKB(bundleBytes)}) [budget check skipped: bundle-guard.json not found]`,
  );
}
