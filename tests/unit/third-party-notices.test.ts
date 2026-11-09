import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FreshBuildResult } from "../helpers/fresh-build";
import { freshBuild } from "../helpers/fresh-build";

// @ts-expect-error scripts/third-party-notices.mjs is an ES module script without a separate .d.ts
import * as noticesModule from "../../scripts/third-party-notices.mjs";

interface LicenseFileEntry {
  readonly filename: string;
  readonly text: string;
}

interface PackageCopy {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly installDirs: readonly string[];
  readonly declaredLicense: string | null;
  readonly repositoryUrl: string | null;
  readonly licenseFiles: readonly LicenseFileEntry[];
  readonly noticeFiles: readonly LicenseFileEntry[];
  readonly reviewReasons: readonly string[];
}

interface NoticesDiff {
  readonly ok: boolean;
  readonly missingFromNotices: readonly string[];
  readonly extraInNotices: readonly string[];
  readonly duplicateInNotices: readonly string[];
  readonly message: string;
}

interface ThirdPartyNoticesApi {
  readonly STANDARD_LICENSES: ReadonlySet<string>;
  readonly extractInstallDirFromInputPath: (inputPath: string) => string | null;
  readonly extractPackageDirsFromMetafile: (metafile: {
    readonly inputs?: Record<string, unknown>;
  }) => string[];
  readonly normalizeDeclaredLicense: (pkgJson: Record<string, unknown>) => string | null;
  readonly normalizeRepositoryUrl: (pkgJson: Record<string, unknown>) => string | null;
  readonly readPackageCopy: (absPkgDir: string, installDir: string) => PackageCopy;
  readonly collectInventoryFromMetafile: (
    metafile: { readonly inputs?: Record<string, unknown> },
    baseDir: string,
  ) => PackageCopy[];
  readonly buildBundleWithMetafile: (options?: {
    readonly repoRoot?: string;
    readonly srcDir?: string;
    readonly workDir?: string;
  }) => Promise<{
    readonly metafile: { readonly inputs: Record<string, unknown> };
    readonly bundleText: string;
  }>;
  readonly collectBundleInventory: (options?: {
    readonly repoRoot?: string;
    readonly srcDir?: string;
    readonly workDir?: string;
  }) => Promise<PackageCopy[]>;
  readonly renderThirdPartyNotices: (inventory: readonly PackageCopy[]) => string;
  readonly parseNoticesPackageIds: (noticesText: string) => string[];
  readonly diffNoticesInventory: (
    inventory: readonly { readonly id: string }[],
    noticesText: string,
  ) => NoticesDiff;
  readonly assertNoticesMatchInventory: (
    inventory: readonly { readonly id: string }[],
    noticesText: string,
  ) => void;
  readonly runCli: (argv?: readonly string[]) => Promise<void>;
}

const {
  extractInstallDirFromInputPath,
  collectInventoryFromMetafile,
  buildBundleWithMetafile,
  collectBundleInventory,
  renderThirdPartyNotices,
  parseNoticesPackageIds,
  diffNoticesInventory,
  assertNoticesMatchInventory,
  normalizeDeclaredLicense,
  readPackageCopy,
  runCli,
} = noticesModule as unknown as ThirdPartyNoticesApi;

const REPO_ROOT = path.resolve(__dirname, "../..");
const NOTICES_PATH = path.join(REPO_ROOT, "THIRD_PARTY_NOTICES.txt");
const README_PATH = path.join(REPO_ROOT, "README.md");

async function withFreshBuild(
  fn: (result: FreshBuildResult) => Promise<void> | void,
): Promise<void> {
  let result: FreshBuildResult | undefined;
  try {
    result = freshBuild();
    await fn(result);
  } finally {
    if (result !== undefined) {
      result.cleanup();
    }
  }
}

describe("third-party notices from bundle inventory (#446)", () => {
  const committedNotices = fs.readFileSync(NOTICES_PATH, "utf8");

  it("regenerates inventory from a fresh build and matches THIRD_PARTY_NOTICES.txt byte-for-byte", async () => {
    await withFreshBuild(async (fresh) => {
      const { metafile, bundleText } = await buildBundleWithMetafile({
        workDir: fresh.tmpDir,
      });
      // Verify the metafile build uses the exact same bundle configuration as scripts/build.mjs
      const freshBundle = fs.readFileSync(fresh.bundlePath, "utf8");
      expect(bundleText).toBe(freshBundle);

      const inventory = collectInventoryFromMetafile(metafile, fresh.tmpDir);
      expect(inventory.length).toBeGreaterThanOrEqual(110);

      // Must not throw: bundled set and notices file match
      assertNoticesMatchInventory(inventory, committedNotices);

      // Running the renderer twice produces identical bytes matching the committed file
      const renderedFirst = renderThirdPartyNotices(inventory);
      const renderedSecond = renderThirdPartyNotices(inventory);
      expect(renderedFirst).toBe(renderedSecond);
      expect(renderedFirst).toBe(committedNotices);
    });
  });

  it("includes multiple versions of the same package name as separate entries", () => {
    const ids = new Set(parseNoticesPackageIds(committedNotices));
    // Multiple versions present in the bundle must each appear separately by name@version
    expect(ids.has("@actions/http-client@3.0.2")).toBe(true);
    expect(ids.has("@actions/http-client@4.0.1")).toBe(true);
    expect(ids.has("brace-expansion@2.1.7")).toBe(true);
    expect(ids.has("brace-expansion@5.0.12")).toBe(true);
    expect(ids.has("minimatch@5.1.9")).toBe(true);
    expect(ids.has("minimatch@9.0.9")).toBe(true);
    expect(ids.has("minimatch@10.2.6")).toBe(true);
    expect(ids.has("readable-stream@2.3.8")).toBe(true);
    expect(ids.has("readable-stream@4.7.0")).toBe(true);
    expect(ids.has("safe-buffer@5.1.2")).toBe(true);
    expect(ids.has("safe-buffer@5.2.1")).toBe(true);
    expect(ids.has("string_decoder@1.1.1")).toBe(true);
    expect(ids.has("string_decoder@1.3.0")).toBe(true);
  });

  it("flags copies without a license file, missing license field, compound expression, or non-standard license for maintainer review", async () => {
    const inventory = await collectBundleInventory();
    const byId = new Map(inventory.map((item) => [item.id, item]));

    // Five copies without a shipped license file
    const noLicenseFileIds = [
      "@nodable/entities@3.0.0",
      "binary@0.3.0",
      "buffers@0.1.1",
      "chainsaw@0.1.0",
      "isarray@1.0.0",
    ];
    for (const id of noLicenseFileIds) {
      const copy = byId.get(id);
      expect(copy, `expected ${id} in bundle inventory`).toBeDefined();
      expect(copy!.licenseFiles.length).toBe(0);
      expect(copy!.repositoryUrl).toBeTruthy();
      expect(copy!.reviewReasons).toContain("no license text shipped");
      expect(committedNotices).toContain(`Package: ${id}`);
    }
    expect(committedNotices).toContain("NEEDS MAINTAINER REVIEW: no license text shipped");

    // Missing license field: buffers@0.1.1
    const buffers = byId.get("buffers@0.1.1");
    expect(buffers).toBeDefined();
    expect(buffers!.declaredLicense).toBeNull();
    expect(buffers!.reviewReasons).toContain("missing license field in package.json");
    expect(committedNotices).toContain(
      "Status: NEEDS MAINTAINER REVIEW: missing license field in package.json",
    );

    // Compound license expression: @protobuf-ts/runtime@2.11.1
    const protobufRuntime = byId.get("@protobuf-ts/runtime@2.11.1");
    expect(protobufRuntime).toBeDefined();
    expect(protobufRuntime!.declaredLicense).toBe("(Apache-2.0 AND BSD-3-Clause)");
    expect(
      protobufRuntime!.reviewReasons.some((r) => r.includes("compound or dual license expression")),
    ).toBe(true);
    expect(committedNotices).toContain(
      "Status: NEEDS MAINTAINER REVIEW: compound or dual license expression ((Apache-2.0 AND BSD-3-Clause))",
    );

    // Licenses outside {MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, 0BSD}: MIT/X11
    for (const id of ["chainsaw@0.1.0", "traverse@0.3.9"]) {
      const copy = byId.get(id);
      expect(copy).toBeDefined();
      expect(copy!.declaredLicense).toBe("MIT/X11");
      expect(copy!.reviewReasons.some((r) => r.includes('license "MIT/X11" is outside'))).toBe(
        true,
      );
    }
  });

  it("is deterministic and contains LF line endings, no absolute paths, and no timestamps", () => {
    expect(committedNotices.includes("\r")).toBe(false);
    expect(committedNotices).not.toMatch(/(?:^|[\s"'])[A-Za-z]:(?:\\|\/(?!\/))/m);
    expect(committedNotices).not.toContain(REPO_ROOT);
    expect(committedNotices).not.toContain(os.tmpdir());
    expect(committedNotices).not.toMatch(/\/home\/[A-Za-z0-9_-]+\//);
    expect(committedNotices).not.toMatch(/\/Users\/[A-Za-z0-9_-]+\//);
    // No ISO-8601 generation timestamps
    expect(committedNotices).not.toMatch(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("uses the last node_modules/ segment when extracting install directories", () => {
    expect(extractInstallDirFromInputPath("src/main.ts")).toBeNull();
    expect(extractInstallDirFromInputPath("node_modules/lodash/index.js")).toBe(
      "node_modules/lodash",
    );
    expect(extractInstallDirFromInputPath("node_modules/@actions/core/lib/core.js")).toBe(
      "node_modules/@actions/core",
    );
    expect(
      extractInstallDirFromInputPath(
        "node_modules/glob/node_modules/minimatch/dist/commonjs/index.js",
      ),
    ).toBe("node_modules/glob/node_modules/minimatch");
    expect(
      extractInstallDirFromInputPath(
        "node_modules\\@actions\\artifact\\node_modules\\@azure\\core-rest-pipeline\\dist\\index.js",
      ),
    ).toBe("node_modules/@actions/artifact/node_modules/@azure/core-rest-pipeline");
  });

  it("mentions THIRD_PARTY_NOTICES.txt and dist/index.js.LEGAL.txt in README.md", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");
    expect(readme).toContain("THIRD_PARTY_NOTICES.txt");
    expect(readme).toContain("dist/index.js.LEGAL.txt");
  });

  describe("negative tests", () => {
    it("removing one copy from a scratch version of the notices file fails and names that name@version", async () => {
      const inventory = await collectBundleInventory();
      const targetId = "minimatch@9.0.9";
      expect(inventory.some((c) => c.id === targetId)).toBe(true);

      const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-scratch-"));
      try {
        // Remove the Package: minimatch@9.0.9 header from a scratch copy of the notices file
        const scratchContent = committedNotices.replace(
          `Package: ${targetId}\n`,
          "",
        );
        const scratchPath = path.join(scratchDir, "THIRD_PARTY_NOTICES.txt");
        fs.writeFileSync(scratchPath, scratchContent, "utf8");

        const loadedScratch = fs.readFileSync(scratchPath, "utf8");
        const diff = diffNoticesInventory(inventory, loadedScratch);
        expect(diff.ok).toBe(false);
        expect(diff.missingFromNotices).toEqual([targetId]);
        expect(() => {
          assertNoticesMatchInventory(inventory, loadedScratch);
        }).toThrow(targetId);
      } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      }
    });

    it("adding a second version of a package to the inventory produces a separate entry and flags the mismatch by name@version", () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "notices-multi-ver-"));
      try {
        const pkgDirV1 = path.join(tmpRoot, "node_modules", "sample-pkg");
        const pkgDirV2 = path.join(
          tmpRoot,
          "node_modules",
          "consumer-pkg",
          "node_modules",
          "sample-pkg",
        );
        fs.mkdirSync(pkgDirV1, { recursive: true });
        fs.mkdirSync(pkgDirV2, { recursive: true });

        fs.writeFileSync(
          path.join(pkgDirV1, "package.json"),
          JSON.stringify({
            name: "sample-pkg",
            version: "1.0.0",
            license: "MIT",
            repository: "https://github.com/example/sample-pkg.git",
          }),
        );
        fs.writeFileSync(path.join(pkgDirV1, "LICENSE"), "MIT License v1.0.0\n");

        fs.writeFileSync(
          path.join(pkgDirV2, "package.json"),
          JSON.stringify({
            name: "sample-pkg",
            version: "2.0.0",
            license: "MIT",
            repository: "https://github.com/example/sample-pkg.git",
          }),
        );
        fs.writeFileSync(path.join(pkgDirV2, "LICENSE"), "MIT License v2.0.0\n");

        const metafileV1Only = {
          inputs: {
            "node_modules/sample-pkg/index.js": { bytes: 10 },
          },
        };
        const metafileBothVersions = {
          inputs: {
            "node_modules/sample-pkg/index.js": { bytes: 10 },
            "node_modules/consumer-pkg/node_modules/sample-pkg/index.js": { bytes: 20 },
          },
        };

        const inventoryV1 = collectInventoryFromMetafile(metafileV1Only, tmpRoot);
        const noticesV1 = renderThirdPartyNotices(inventoryV1);
        expect(parseNoticesPackageIds(noticesV1)).toEqual(["sample-pkg@1.0.0"]);

        const inventoryBoth = collectInventoryFromMetafile(metafileBothVersions, tmpRoot);
        expect(inventoryBoth.map((c) => c.id)).toEqual([
          "sample-pkg@1.0.0",
          "sample-pkg@2.0.0",
        ]);

        const noticesBoth = renderThirdPartyNotices(inventoryBoth);
        expect(parseNoticesPackageIds(noticesBoth)).toEqual([
          "sample-pkg@1.0.0",
          "sample-pkg@2.0.0",
        ]);
        expect(noticesBoth).toContain("MIT License v1.0.0");
        expect(noticesBoth).toContain("MIT License v2.0.0");

        // Comparing the 2-version inventory against the 1-version notices fails naming sample-pkg@2.0.0
        expect(() => {
          assertNoticesMatchInventory(inventoryBoth, noticesV1);
        }).toThrow("sample-pkg@2.0.0");
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("does not crash when a package uses a license object or licenses array form", () => {
      expect(
        normalizeDeclaredLicense({
          license: { type: "MIT", url: "https://opensource.org/licenses/MIT" },
        }),
      ).toBe("MIT");

      expect(
        normalizeDeclaredLicense({
          license: [
            { type: "MIT", url: "https://opensource.org/licenses/MIT" },
            { type: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
          ],
        }),
      ).toBe("(MIT OR Apache-2.0)");

      expect(
        normalizeDeclaredLicense({
          licenses: [{ type: "BSD-3-Clause", url: "https://opensource.org/licenses/BSD-3-Clause" }],
        }),
      ).toBe("BSD-3-Clause");

      expect(
        normalizeDeclaredLicense({
          licenses: ["ISC", "MIT"],
        }),
      ).toBe("(ISC OR MIT)");

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "notices-lic-forms-"));
      try {
        const objPkgDir = path.join(tmpRoot, "node_modules", "legacy-obj-pkg");
        const arrPkgDir = path.join(tmpRoot, "node_modules", "legacy-arr-pkg");
        fs.mkdirSync(objPkgDir, { recursive: true });
        fs.mkdirSync(arrPkgDir, { recursive: true });

        fs.writeFileSync(
          path.join(objPkgDir, "package.json"),
          JSON.stringify({
            name: "legacy-obj-pkg",
            version: "0.1.0",
            license: { type: "ISC", url: "https://opensource.org/licenses/ISC" },
            repository: { type: "git", url: "https://github.com/example/legacy-obj-pkg.git" },
          }),
        );
        fs.writeFileSync(path.join(objPkgDir, "LICENCE.txt"), "ISC License Text\r\nLine 2\r\n");

        fs.writeFileSync(
          path.join(arrPkgDir, "package.json"),
          JSON.stringify({
            name: "legacy-arr-pkg",
            version: "0.2.0",
            licenses: [
              { type: "MIT", url: "https://opensource.org/licenses/MIT" },
              { type: "BSD-2-Clause", url: "https://opensource.org/licenses/BSD-2-Clause" },
            ],
            repository: "https://github.com/example/legacy-arr-pkg",
          }),
        );
        fs.writeFileSync(path.join(arrPkgDir, "COPYING"), "Dual license text\n");
        fs.writeFileSync(path.join(arrPkgDir, "NOTICE"), "Attribution notice text\r\n");

        const copyObj = readPackageCopy(objPkgDir, "node_modules/legacy-obj-pkg");
        expect(copyObj.declaredLicense).toBe("ISC");
        expect(copyObj.licenseFiles).toEqual([
          { filename: "LICENCE.txt", text: "ISC License Text\nLine 2\n" },
        ]);

        const copyArr = readPackageCopy(arrPkgDir, "node_modules/legacy-arr-pkg");
        expect(copyArr.declaredLicense).toBe("(MIT OR BSD-2-Clause)");
        expect(copyArr.noticeFiles).toEqual([
          { filename: "NOTICE", text: "Attribution notice text\n" },
        ]);

        const rendered = renderThirdPartyNotices([copyObj, copyArr]);
        expect(rendered).toContain("Package: legacy-obj-pkg@0.1.0");
        expect(rendered).toContain("Package: legacy-arr-pkg@0.2.0");
        expect(rendered).toContain("Attribution notice text");
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it("fails the script with the build output when the build fails and cleans up temporary directories", async () => {
      const tempPrefix = "third-party-notices-build-";
      const countTempDirs = (): number =>
        fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(tempPrefix)).length;

      const before = countTempDirs();
      const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "notices-broken-src-"));
      try {
        const brokenSrcDir = path.join(brokenRoot, "src");
        fs.cpSync(path.join(REPO_ROOT, "src"), brokenSrcDir, { recursive: true });
        fs.appendFileSync(
          path.join(brokenSrcDir, "main.ts"),
          "\n;;; BROKEN_TYPESCRIPT_SYNTAX_FOR_446 :::\n",
        );

        let caughtError: unknown;
        try {
          await runCli([
            "--src-dir",
            brokenSrcDir,
            "--out",
            path.join(brokenRoot, "THIRD_PARTY_NOTICES.txt"),
          ]);
        } catch (error) {
          caughtError = error;
        }

        expect(caughtError).toBeDefined();
        const message = String(caughtError);
        expect(message).toContain("Fresh build");
        expect(message).toContain("failed");
        expect(message).toContain("main.ts");
      } finally {
        fs.rmSync(brokenRoot, { recursive: true, force: true });
      }
      expect(countTempDirs()).toBe(before);
    });
  });
});
