#!/usr/bin/env node
// @ts-check

import { build } from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Shared esbuild configuration matching `scripts/build.mjs`.
 */
export const BUILD_OPTIONS = Object.freeze({
  entryPoints: ["src/main.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  minify: true,
  sourcemap: true,
  legalComments: "linked",
  preserveSymlinks: true,
});

/**
 * Standard single-identifier licenses from issue #446 that do not require
 * special license-expression maintainer review when a license file is present.
 */
export const STANDARD_LICENSES = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "0BSD",
]);

const LICENSE_FILE_RE = /^(?:LICENSE|LICENCE|COPYING)/i;
const NOTICE_FILE_RE = /^NOTICE/i;

/**
 * Deterministic ASCII/code-point comparator.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Extracts the contributing `node_modules/<package>` install directory from a
 * single esbuild metafile input path using its LAST `node_modules/` segment.
 * Returns `null` for paths outside `node_modules/` (such as `src/main.ts`).
 *
 * @param {string} inputPath
 * @returns {string | null}
 */
export function extractInstallDirFromInputPath(inputPath) {
  const normalized = inputPath.replace(/\\/g, "/");
  const marker = "node_modules/";
  const lastIdx = normalized.lastIndexOf(marker);
  if (lastIdx === -1) {
    return null;
  }
  const after = normalized.slice(lastIdx + marker.length);
  const parts = after.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }
  if (parts[0].startsWith("@")) {
    if (parts.length < 2) {
      return null;
    }
    return `${normalized.slice(0, lastIdx + marker.length)}${parts[0]}/${parts[1]}`;
  }
  return `${normalized.slice(0, lastIdx + marker.length)}${parts[0]}`;
}

/**
 * Collects every distinct `node_modules/<package>` directory that contributed
 * an input file to the esbuild metafile.
 *
 * @param {{ inputs?: Record<string, unknown> }} metafile
 * @returns {string[]}
 */
export function extractPackageDirsFromMetafile(metafile) {
  if (!metafile || typeof metafile !== "object" || !metafile.inputs) {
    throw new Error("Invalid esbuild metafile: missing 'inputs' map.");
  }
  const dirs = new Set();
  for (const inputPath of Object.keys(metafile.inputs)) {
    const installDir = extractInstallDirFromInputPath(inputPath);
    if (installDir !== null) {
      dirs.add(installDir);
    }
  }
  return [...dirs].sort(compareStrings);
}

/**
 * Normalizes a single license value (string or `{ type, url }` object).
 *
 * @param {unknown} entry
 * @returns {string | null}
 */
function normalizeSingleLicenseEntry(entry) {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof entry === "object" && entry !== null) {
    const record = /** @type {Record<string, unknown>} */ (entry);
    if (typeof record.type === "string" && record.type.trim().length > 0) {
      return record.type.trim();
    }
    if (typeof record.name === "string" && record.name.trim().length > 0) {
      return record.name.trim();
    }
  }
  return null;
}

/**
 * Normalizes the declared license from a `package.json` object without crashing
 * when `license` or legacy `licenses` is an object or array.
 *
 * @param {Record<string, unknown>} pkgJson
 * @returns {string | null}
 */
export function normalizeDeclaredLicense(pkgJson) {
  const rawLicense = pkgJson.license;
  if (typeof rawLicense === "string") {
    const trimmed = rawLicense.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  } else if (Array.isArray(rawLicense)) {
    const parts = rawLicense
      .map(normalizeSingleLicenseEntry)
      .filter(/** @returns {part is string} */ (part) => part !== null);
    if (parts.length === 1) {
      return parts[0];
    }
    if (parts.length > 1) {
      return `(${parts.join(" OR ")})`;
    }
  } else if (typeof rawLicense === "object" && rawLicense !== null) {
    const single = normalizeSingleLicenseEntry(rawLicense);
    if (single !== null) {
      return single;
    }
  }

  const rawLicenses = pkgJson.licenses;
  if (typeof rawLicenses === "string") {
    const trimmed = rawLicenses.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  } else if (Array.isArray(rawLicenses)) {
    const parts = rawLicenses
      .map(normalizeSingleLicenseEntry)
      .filter(/** @returns {part is string} */ (part) => part !== null);
    if (parts.length === 1) {
      return parts[0];
    }
    if (parts.length > 1) {
      return `(${parts.join(" OR ")})`;
    }
  } else if (typeof rawLicenses === "object" && rawLicenses !== null) {
    const single = normalizeSingleLicenseEntry(rawLicenses);
    if (single !== null) {
      return single;
    }
  }

  return null;
}

/**
 * Extracts a repository URL string from `package.json`'s `repository` field.
 *
 * @param {Record<string, unknown>} pkgJson
 * @returns {string | null}
 */
export function normalizeRepositoryUrl(pkgJson) {
  const repo = pkgJson.repository;
  if (typeof repo === "string") {
    const trimmed = repo.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof repo === "object" && repo !== null) {
    const record = /** @type {Record<string, unknown>} */ (repo);
    if (typeof record.url === "string" && record.url.trim().length > 0) {
      return record.url.trim();
    }
  }
  if (typeof pkgJson.homepage === "string" && pkgJson.homepage.trim().length > 0) {
    return pkgJson.homepage.trim();
  }
  return null;
}

/**
 * Reads a file as bytes, decodes as UTF-8, and normalizes CRLF/CR line endings
 * to LF without altering or re-wrapping the text.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function readTextAsNormalizedLf(filePath) {
  const rawBytes = fs.readFileSync(filePath);
  return rawBytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Computes any maintainer-review flags for a package copy.
 *
 * @param {string | null} declaredLicense
 * @param {readonly { filename: string; text: string }[]} licenseFiles
 * @returns {string[]}
 */
export function computeReviewReasons(declaredLicense, licenseFiles) {
  const reasons = [];
  if (declaredLicense === null) {
    reasons.push("missing license field in package.json");
  } else if (
    /\b(?:AND|OR|WITH)\b/.test(declaredLicense) ||
    declaredLicense.startsWith("(") ||
    declaredLicense.endsWith(")")
  ) {
    reasons.push(`compound or dual license expression (${declaredLicense})`);
  } else if (!STANDARD_LICENSES.has(declaredLicense)) {
    reasons.push(
      `license "${declaredLicense}" is outside {MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, 0BSD}`,
    );
  }

  if (licenseFiles.length === 0) {
    reasons.push("no license text shipped");
  }

  return reasons;
}

/**
 * Reads a single installed package directory (`package.json`, `LICENSE*` /
 * `LICENCE*` / `COPYING*`, and `NOTICE*`).
 *
 * @param {string} absPkgDir
 * @param {string} installDir
 */
export function readPackageCopy(absPkgDir, installDir) {
  const pkgJsonPath = path.join(absPkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`Missing package.json in bundled package directory: ${installDir}`);
  }
  const pkgJson = /** @type {Record<string, unknown>} */ (
    JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"))
  );
  const name = typeof pkgJson.name === "string" ? pkgJson.name.trim() : "";
  const version = typeof pkgJson.version === "string" ? pkgJson.version.trim() : "";
  if (!name || !version) {
    throw new Error(`Bundled package at ${installDir} is missing name or version in package.json`);
  }

  const declaredLicense = normalizeDeclaredLicense(pkgJson);
  const repositoryUrl = normalizeRepositoryUrl(pkgJson);

  const dirEntries = fs.readdirSync(absPkgDir, { withFileTypes: true });
  const fileNames = dirEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareStrings);

  const licenseFiles = fileNames
    .filter((fname) => LICENSE_FILE_RE.test(fname))
    .map((fname) => ({
      filename: fname,
      text: readTextAsNormalizedLf(path.join(absPkgDir, fname)),
    }));

  const noticeFiles = fileNames
    .filter((fname) => NOTICE_FILE_RE.test(fname))
    .map((fname) => ({
      filename: fname,
      text: readTextAsNormalizedLf(path.join(absPkgDir, fname)),
    }));

  const reviewReasons = computeReviewReasons(declaredLicense, licenseFiles);

  return {
    id: `${name}@${version}`,
    name,
    version,
    installDirs: [installDir.replace(/\\/g, "/")],
    declaredLicense,
    repositoryUrl,
    licenseFiles,
    noticeFiles,
    reviewReasons,
  };
}

/**
 * Builds the bundle inventory from an esbuild metafile and a base directory
 * containing the referenced `node_modules` tree.
 *
 * Distinct versions of the same package name are preserved as separate copies;
 * identical `name@version` copies duplicated across nested `node_modules`
 * directories are merged into a single `name@version` record.
 *
 * @param {{ inputs?: Record<string, unknown> }} metafile
 * @param {string} baseDir
 */
export function collectInventoryFromMetafile(metafile, baseDir) {
  const pkgDirs = extractPackageDirsFromMetafile(metafile);
  /** @type {Map<string, ReturnType<typeof readPackageCopy>>} */
  const byId = new Map();

  for (const relDir of pkgDirs) {
    const absDir = path.resolve(baseDir, relDir);
    const copy = readPackageCopy(absDir, relDir);
    const existing = byId.get(copy.id);
    if (existing) {
      for (const dir of copy.installDirs) {
        if (!existing.installDirs.includes(dir)) {
          existing.installDirs.push(dir);
          existing.installDirs.sort(compareStrings);
        }
      }
    } else {
      byId.set(copy.id, copy);
    }
  }

  return [...byId.values()].sort((a, b) => {
    const byName = compareStrings(a.name, b.name);
    if (byName !== 0) return byName;
    return compareStrings(a.version, b.version);
  });
}

/**
 * Formats an esbuild build error into a diagnostic string that includes the
 * compiler/bundler error messages.
 *
 * @param {unknown} error
 * @returns {string}
 */
function formatBuildError(error) {
  if (typeof error === "object" && error !== null) {
    const record = /** @type {Record<string, unknown>} */ (error);
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      const formatted = record.errors
        .map((err) => {
          if (typeof err === "object" && err !== null) {
            const e = /** @type {Record<string, unknown>} */ (err);
            const loc =
              typeof e.location === "object" && e.location !== null
                ? /** @type {Record<string, unknown>} */ (e.location)
                : null;
            const prefix =
              loc && typeof loc.file === "string"
                ? `${loc.file}:${String(loc.line ?? 0)}:${String(loc.column ?? 0)}: `
                : "";
            return `${prefix}${typeof e.text === "string" ? e.text : JSON.stringify(e)}`;
          }
          return String(err);
        })
        .join("\n");
      return `${String(error)}\n${formatted}`;
    }
  }
  return error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
}

/**
 * Runs the repository build in a temporary directory with `metafile: true`
 * (or inside an existing fresh-build `workDir` if provided) and returns the
 * resulting metafile and bundle contents. Always cleans up any temporary
 * directory it creates, including on build failure.
 *
 * @param {{ repoRoot?: string; srcDir?: string; workDir?: string }} [options]
 */
export async function buildBundleWithMetafile(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;

  if (options.workDir !== undefined) {
    const workDir = options.workDir;
    const outfile = path.join(workDir, "dist", "index.js");
    try {
      const result = await build({
        ...BUILD_OPTIONS,
        entryPoints: [...BUILD_OPTIONS.entryPoints],
        absWorkingDir: workDir,
        outfile,
        metafile: true,
        logLevel: "silent",
      });
      const bundleText = fs.readFileSync(outfile, "utf8");
      return { metafile: result.metafile, bundleText };
    } catch (error) {
      throw new Error(`Build in ${workDir} failed:\n${formatBuildError(error)}`);
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "third-party-notices-build-"));
  try {
    const srcDir = options.srcDir ?? path.join(repoRoot, "src");
    fs.cpSync(srcDir, path.join(tmpDir, "src"), { recursive: true });
    fs.cpSync(path.join(repoRoot, "package.json"), path.join(tmpDir, "package.json"));
    fs.cpSync(path.join(repoRoot, "tsconfig.json"), path.join(tmpDir, "tsconfig.json"));
    fs.symlinkSync(
      path.join(repoRoot, "node_modules"),
      path.join(tmpDir, "node_modules"),
      "junction",
    );

    const outfile = path.join(tmpDir, "dist", "index.js");
    let result;
    try {
      result = await build({
        ...BUILD_OPTIONS,
        entryPoints: [...BUILD_OPTIONS.entryPoints],
        absWorkingDir: tmpDir,
        outfile,
        metafile: true,
        logLevel: "silent",
      });
    } catch (error) {
      throw new Error(`Fresh build in ${tmpDir} failed:\n${formatBuildError(error)}`);
    }

    const bundleText = fs.readFileSync(outfile, "utf8");
    return { metafile: result.metafile, bundleText };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Builds the bundle in a temporary directory (or uses a provided `workDir` from
 * `freshBuild`) and collects the complete inventory of bundled package copies.
 *
 * @param {{ repoRoot?: string; srcDir?: string; workDir?: string }} [options]
 */
export async function collectBundleInventory(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const baseDir = options.workDir ?? repoRoot;
  const { metafile } = await buildBundleWithMetafile(options);
  return collectInventoryFromMetafile(metafile, baseDir);
}

/**
 * Renders the deterministic `THIRD_PARTY_NOTICES.txt` content from the
 * collected bundle inventory, grouped by license type and sorted by package
 * name then version, with LF line endings and no timestamps or absolute paths.
 *
 * @param {readonly ReturnType<typeof readPackageCopy>[]} inventory
 * @returns {string}
 */
export function renderThirdPartyNotices(inventory) {
  const sorted = [...inventory].sort((a, b) => {
    const byName = compareStrings(a.name, b.name);
    if (byName !== 0) return byName;
    return compareStrings(a.version, b.version);
  });

  /** @type {Map<string, ReturnType<typeof readPackageCopy>[]>} */
  const groups = new Map();
  for (const copy of sorted) {
    const groupKey = copy.declaredLicense ?? "(none)";
    let list = groups.get(groupKey);
    if (!list) {
      list = [];
      groups.set(groupKey, list);
    }
    list.push(copy);
  }

  const groupKeys = [...groups.keys()].sort(compareStrings);
  const lines = [
    "THIRD-PARTY SOFTWARE NOTICES AND LICENSE INFORMATION",
    "====================================================",
    "",
    "This file lists the third-party npm package copies bundled into dist/index.js,",
    "derived from esbuild's bundle metafile inventory (scripts/third-party-notices.mjs).",
    "Each entry records the package's declared license metadata and reproduces any",
    "shipped LICENSE/LICENCE/COPYING and NOTICE files verbatim.",
    "Entries with missing license text, missing license metadata, compound license",
    "expressions, or licenses outside the standard set are marked with",
    "NEEDS MAINTAINER REVIEW.",
    "",
    `Total bundled package copies: ${sorted.length}`,
  ];

  for (const groupKey of groupKeys) {
    const groupCopies = groups.get(groupKey) ?? [];
    lines.push("");
    lines.push("================================================================================");
    lines.push(`License Group: ${groupKey} (${groupCopies.length} ${groupCopies.length === 1 ? "copy" : "copies"})`);
    lines.push("================================================================================");

    for (const copy of groupCopies) {
      lines.push("");
      lines.push("--------------------------------------------------------------------------------");
      lines.push(`Package: ${copy.name}@${copy.version}`);
      lines.push(`Name: ${copy.name}`);
      lines.push(`Version: ${copy.version}`);
      lines.push(`Declared License: ${copy.declaredLicense ?? "(none)"}`);
      lines.push(`Repository: ${copy.repositoryUrl ?? "(none)"}`);
      for (const reason of copy.reviewReasons) {
        lines.push(`Status: NEEDS MAINTAINER REVIEW: ${reason}`);
      }
      lines.push("--------------------------------------------------------------------------------");

      if (copy.licenseFiles.length === 0) {
        lines.push("");
        lines.push("NEEDS MAINTAINER REVIEW: no license text shipped");
      } else {
        for (const licFile of copy.licenseFiles) {
          lines.push("");
          lines.push(`--- ${licFile.filename} ---`);
          const trimmedTrailing = licFile.text.endsWith("\n")
            ? licFile.text.slice(0, -1)
            : licFile.text;
          lines.push(trimmedTrailing);
        }
      }

      for (const noticeFile of copy.noticeFiles) {
        lines.push("");
        lines.push(`--- ${noticeFile.filename} ---`);
        const trimmedTrailing = noticeFile.text.endsWith("\n")
          ? noticeFile.text.slice(0, -1)
          : noticeFile.text;
        lines.push(trimmedTrailing);
      }
    }
  }

  lines.push("");
  return lines.join("\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Extracts all `name@version` package identifiers listed in a rendered
 * `THIRD_PARTY_NOTICES.txt` document.
 *
 * @param {string} noticesText
 * @returns {string[]}
 */
export function parseNoticesPackageIds(noticesText) {
  const ids = [];
  const normalized = noticesText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const line of normalized.split("\n")) {
    if (line.startsWith("Package: ")) {
      const id = line.slice("Package: ".length).trim();
      if (id.length > 0) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Compares the set of bundled package copies against the copies listed in a
 * `THIRD_PARTY_NOTICES.txt` document and reports any `name@version` differences.
 *
 * @param {readonly { id: string }[]} inventory
 * @param {string} noticesText
 */
export function diffNoticesInventory(inventory, noticesText) {
  const bundledSet = new Set(inventory.map((item) => item.id));
  const noticesIds = parseNoticesPackageIds(noticesText);
  const noticesSet = new Set(noticesIds);

  const missingFromNotices = [...bundledSet]
    .filter((id) => !noticesSet.has(id))
    .sort(compareStrings);
  const extraInNotices = [...noticesSet]
    .filter((id) => !bundledSet.has(id))
    .sort(compareStrings);

  const countMap = new Map();
  for (const id of noticesIds) {
    countMap.set(id, (countMap.get(id) ?? 0) + 1);
  }
  const duplicateInNotices = [...countMap.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort(compareStrings);

  const ok =
    missingFromNotices.length === 0 &&
    extraInNotices.length === 0 &&
    duplicateInNotices.length === 0;

  const parts = [];
  if (missingFromNotices.length > 0) {
    parts.push(`Missing from THIRD_PARTY_NOTICES.txt: ${missingFromNotices.join(", ")}`);
  }
  if (extraInNotices.length > 0) {
    parts.push(`Extra in THIRD_PARTY_NOTICES.txt (not in bundle): ${extraInNotices.join(", ")}`);
  }
  if (duplicateInNotices.length > 0) {
    parts.push(`Duplicate entries in THIRD_PARTY_NOTICES.txt: ${duplicateInNotices.join(", ")}`);
  }

  return {
    ok,
    missingFromNotices,
    extraInNotices,
    duplicateInNotices,
    message: parts.join("\n"),
  };
}

/**
 * Throws an Error naming every `name@version` difference when the bundled
 * inventory and `noticesText` do not match.
 *
 * @param {readonly { id: string }[]} inventory
 * @param {string} noticesText
 */
export function assertNoticesMatchInventory(inventory, noticesText) {
  const diff = diffNoticesInventory(inventory, noticesText);
  if (!diff.ok) {
    throw new Error(`THIRD_PARTY_NOTICES.txt is out of sync with bundle inventory:\n${diff.message}`);
  }
}

/**
 * CLI entry point. Generates `THIRD_PARTY_NOTICES.txt` (or checks it when
 * `--check` is passed).
 *
 * @param {readonly string[]} [argv]
 */
export async function runCli(argv = process.argv.slice(2)) {
  let outPath = path.join(DEFAULT_REPO_ROOT, "THIRD_PARTY_NOTICES.txt");
  let srcDir;
  let checkOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      checkOnly = true;
    } else if (arg === "--out" && i + 1 < argv.length) {
      outPath = path.resolve(argv[++i]);
    } else if (arg === "--src-dir" && i + 1 < argv.length) {
      srcDir = path.resolve(argv[++i]);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  const inventory = await collectBundleInventory(srcDir !== undefined ? { srcDir } : {});
  const rendered = renderThirdPartyNotices(inventory);

  if (checkOnly) {
    if (!fs.existsSync(outPath)) {
      throw new Error(`THIRD_PARTY_NOTICES.txt not found at ${outPath}`);
    }
    const existing = fs.readFileSync(outPath, "utf8");
    assertNoticesMatchInventory(inventory, existing);
    if (existing !== rendered) {
      throw new Error(
        `THIRD_PARTY_NOTICES.txt content differs from freshly rendered notices. Run 'node scripts/third-party-notices.mjs' to regenerate.`,
      );
    }
    return;
  }

  fs.writeFileSync(outPath, Buffer.from(rendered, "utf8"));
  console.log(`Wrote ${outPath} (${inventory.length} bundled package copies).`);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
