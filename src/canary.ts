import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

import {
  CanaryExecutionFailedError,
  CanaryNotFoundError,
  InstallationFailedError,
  TimeoutError,
  UnsupportedPlatformError,
} from "./errors";
import type { CheckExecutionResult } from "./runner";
import { CARGO_INSTALL_TIMEOUT_FLOOR_MS, runCheck } from "./runner";
import type { ResolvedVersion } from "./version";
import { CANARY_API_REPO_URL, CANARY_REPO_URL } from "./version";

/**
 * Describes a Canary binary that has been located or restored and verified
 * ready for the Action to execute.
 *
 * The reported version is read from the binary itself and has been checked
 * against the resolved requested version; it is not merely the requested
 * input value.
 */
export interface InstalledCanary {
  /** Absolute path to the verified executable on the runner. */
  readonly binaryPath: string;
  /** Version reported by the executable after verification. */
  readonly version: string;
}

function cargoBinDir(): string {
  const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo");
  return path.join(cargoHome, "bin");
}

function binaryName(): string {
  return process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary";
}

/** Asset names a Protocol-Canary release is expected to use for its
 * checksum manifest (for example `SHA256SUMS` or `checksums.txt`). */
const CHECKSUM_ASSET_PATTERN = /(sha-?256|sha-?512|checksums?|shasums?)/i;
const CHECKSUM_REQUEST_TIMEOUT_MS = 10_000;

interface ReleaseAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
}

/** GETs a URL as text, authenticating when a token is available. Rejects on
 * any non-200 response, timeout, or transport error. */
function httpsGetText(url: string, token: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "User-Agent": "ProtocolCanary-Action",
      Accept: "application/vnd.github+json",
    };
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }

    const request = https.get(url, { headers, timeout: CHECKSUM_REQUEST_TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub returned status ${String(response.statusCode)} for ${url}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve(body);
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timed out fetching ${url}`));
    });
    request.on("error", reject);
  });
}

/** Parses a `sha256sum`-style manifest (`<hex digest>  <filename>` lines,
 * with `*` binary-mode markers and `#` comments tolerated) into a map of
 * file base name to lower-case hex digest. */
function parseChecksumManifest(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    const digest = match?.[1];
    const file = match?.[2];
    if (digest === undefined || file === undefined) {
      continue;
    }
    entries.set(path.basename(file.trim()), digest.toLowerCase());
  }
  return entries;
}

/**
 * Looks up the checksum manifest Protocol-Canary publishes alongside a
 * release, if any. Returns `undefined` — never throws — when no release,
 * no checksum asset, or no parseable manifest is available, so callers can
 * fall back to commit/tag pinning exactly as before.
 */
async function lookupPublishedChecksums(version: string): Promise<Map<string, string> | undefined> {
  const token = (process.env.GITHUB_TOKEN ?? "").trim() === "" ? undefined : process.env.GITHUB_TOKEN?.trim();
  try {
    const releaseBody = await httpsGetText(`${CANARY_API_REPO_URL}/releases/tags/v${version}`, token);
    const parsed = JSON.parse(releaseBody) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const assets = (parsed as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) {
      return undefined;
    }
    const checksumAsset = (assets as ReleaseAsset[]).find(
      (asset) =>
        typeof asset.name === "string" &&
        CHECKSUM_ASSET_PATTERN.test(asset.name) &&
        typeof asset.browser_download_url === "string",
    );
    if (checksumAsset === undefined) {
      return undefined;
    }
    const manifest = await httpsGetText(checksumAsset.browser_download_url as string, token);
    const entries = parseChecksumManifest(manifest);
    return entries.size > 0 ? entries : undefined;
  } catch (error) {
    core.debug(`Could not look up a published checksum for Protocol-Canary ${version}: ${String(error)}`);
    return undefined;
  }
}

/** Release archives (`.tar.gz`, `.zip`, ...) are not the executable itself;
 * their digests must never be compared against an installed binary. */
const ARCHIVE_ASSET_PATTERN = /\.(?:tar\.gz|tgz|tar\.xz|zip)$/i;

/** Chooses the manifest entry that corresponds to the binary this runner
 * will execute, preferring an exact file-name match and falling back to a
 * platform match when the manifest names per-target artifacts. Archive
 * entries are skipped: a checksum for `stellar-canary-...-x86_64.tar.gz` is
 * not a checksum for the extracted binary. */
function selectExpectedChecksum(entries: Map<string, string>, binary: string): string | undefined {
  const exact = entries.get(binary);
  if (exact !== undefined) {
    return exact;
  }
  const candidates = [...entries.entries()].filter(
    ([name]) => name.includes("stellar-canary") && !ARCHIVE_ASSET_PATTERN.test(name),
  );
  const platformAndArch = candidates.find(
    ([name]) => name.includes(process.platform) && name.includes(process.arch),
  );
  if (platformAndArch !== undefined) {
    return platformAndArch[1];
  }
  const platformOnly = candidates.find(([name]) => name.includes(process.platform));
  if (platformOnly !== undefined) {
    return platformOnly[1];
  }
  const only = candidates[0];
  return candidates.length === 1 && only !== undefined ? only[1] : undefined;
}

/** Hashes a file with SHA-256, streaming so a large binary never has to be
 * read into memory all at once. */
async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

/**
 * Prebuilt release targets published by Protocol-Canary, keyed by
 * `<process.platform>-<process.arch>`. These are the Rust target triples the
 * release assets are built for; any other combination has no prebuilt
 * binary and falls back to a source install.
 */
export const PREBUILT_TARGETS: Readonly<Record<string, string>> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const PREBUILT_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

/**
 * Maps a runner platform/architecture pair to the Protocol-Canary release
 * target triple, or `undefined` when no prebuilt binary exists for it.
 */
export function prebuiltTargetFor(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  return PREBUILT_TARGETS[`${platform}-${arch}`];
}

/**
 * Like {@link prebuiltTargetFor}, but throws a clear
 * {@link UnsupportedPlatformError} naming the supported runners instead of
 * returning `undefined`. The install chain catches it and falls back to
 * `cargo install`, so an unsupported runner still works — it just builds
 * from source.
 */
export function prebuiltTargetOrThrow(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const target = prebuiltTargetFor(platform, arch);
  if (target !== undefined) {
    return target;
  }
  throw new UnsupportedPlatformError(
    `No prebuilt stellar-canary binary is published for ${platform}-${arch}. ` +
      `Supported runners: ${Object.keys(PREBUILT_TARGETS).join(", ")}. ` +
      "Falling back to a source install with `cargo install`.",
  );
}

/** The release asset name for a prebuilt binary of `version` on `target`. */
export function prebuiltAssetName(version: string, target: string): string {
  return `stellar-canary-${version}-${target}.tar.gz`;
}

interface DownloadableAsset {
  readonly name: string;
  readonly url: string;
}

function githubToken(): string | undefined {
  const token = (process.env.GITHUB_TOKEN ?? "").trim();
  return token === "" ? undefined : token;
}

/**
 * Lists the assets attached to the Protocol-Canary release for `version`.
 * Returns `undefined` — never throws — when the release or its asset list is
 * unavailable, so callers can fall back to a source install.
 */
async function fetchReleaseAssets(version: string): Promise<readonly DownloadableAsset[] | undefined> {
  try {
    const body = await httpsGetText(`${CANARY_API_REPO_URL}/releases/tags/v${version}`, githubToken());
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const assets = (parsed as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) {
      return undefined;
    }
    return (assets as ReleaseAsset[])
      .filter(
        (asset): asset is { name: string; browser_download_url: string } =>
          typeof asset.name === "string" && typeof asset.browser_download_url === "string",
      )
      .map((asset) => ({ name: asset.name, url: asset.browser_download_url }));
  } catch (error) {
    core.debug(`Could not list release assets for Protocol-Canary ${version}: ${String(error)}`);
    return undefined;
  }
}

/**
 * Downloads `url` to `destination`, following GitHub's redirect to its
 * object-storage host and streaming bytes to disk so a binary never has to
 * be held in memory whole. Rejects on a non-200 response, a redirect chain
 * longer than {@link MAX_REDIRECTS}, a timeout, or a transport error.
 */
function downloadReleaseAsset(
  url: string,
  destination: string,
  redirectsLeft: number = MAX_REDIRECTS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "User-Agent": "ProtocolCanary-Action" };
    const token = githubToken();
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }

    const request = https.get(url, { headers, timeout: PREBUILT_DOWNLOAD_TIMEOUT_MS }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && typeof location === "string") {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        resolve(downloadReleaseAsset(new URL(location, url).toString(), destination, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`GitHub returned status ${String(status)} for ${url}`));
        return;
      }

      const fd = fs.openSync(destination, "w");
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          fs.closeSync(fd);
        } catch {
          // The descriptor is already closed; nothing else to clean up.
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      response.on("data", (chunk: string | Buffer) => {
        try {
          fs.writeSync(fd, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        } catch (error) {
          fail(error);
        }
      });
      response.on("error", fail);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        fs.closeSync(fd);
        resolve();
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`timed out downloading ${url}`));
    });
    request.on("error", reject);
  });
}

/**
 * Verifies a downloaded release archive against the checksum manifest
 * published with the same release, when one exists. A mismatch always throws
 * (so a tampered or corrupted archive is never extracted); a missing
 * manifest or entry degrades to a debug log, matching the existing binary
 * verification policy in SECURITY.md.
 */
async function verifyDownloadedArchive(
  archivePath: string,
  assetName: string,
  assets: readonly DownloadableAsset[],
  version: string,
): Promise<void> {
  const manifestAsset = assets.find((asset) => CHECKSUM_ASSET_PATTERN.test(asset.name));
  if (manifestAsset === undefined) {
    core.debug(
      `No published checksum manifest for Protocol-Canary ${version}; relying on HTTPS and the pinned release tag.`,
    );
    return;
  }
  const expected = parseChecksumManifest(await httpsGetText(manifestAsset.url, githubToken())).get(assetName);
  if (expected === undefined) {
    core.debug(`Published checksum manifest has no entry for ${assetName}; relying on HTTPS and the pinned release tag.`);
    return;
  }
  const actual = await sha256File(archivePath);
  if (actual !== expected) {
    throw new InstallationFailedError(
      `Checksum verification failed for ${assetName}: expected SHA-256 ${expected}, but the downloaded archive ` +
        `hashes to ${actual}. Refusing to use it (see SECURITY.md).`,
    );
  }
  core.info(`Verified ${assetName} against the published SHA-256 checksum.`);
}

/** Extracts a `.tar.gz` release archive with the runner's `tar`. */
async function extractArchive(archivePath: string, destinationDir: string): Promise<void> {
  fs.mkdirSync(destinationDir, { recursive: true });
  const exitCode = await exec.exec("tar", ["-xzf", archivePath, "-C", destinationDir], { silent: true });
  if (exitCode !== 0) {
    throw new InstallationFailedError(
      `Failed to extract ${path.basename(archivePath)} (tar exited with code ${String(exitCode)}).`,
    );
  }
}

/** Finds the executable inside an extracted release archive, tolerating both
 * a flat archive and one that nests the binary under a directory or `bin/`. */
function findExtractedBinary(directory: string): string | undefined {
  const candidates = [path.join(directory, binaryName()), path.join(directory, "bin", binaryName())];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      candidates.push(
        path.join(directory, entry.name, binaryName()),
        path.join(directory, entry.name, "bin", binaryName()),
      );
    }
  }
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/** Directory under the runner tool cache where a prebuilt binary is placed. */
function prebuiltInstallDir(version: string, target: string): string {
  const toolCache = process.env.RUNNER_TOOL_CACHE ?? path.join(os.tmpdir(), "stellar-canary-tool-cache");
  return path.join(toolCache, "stellar-canary", version, target);
}

/**
 * Downloads, verifies, extracts and installs the official prebuilt
 * `stellar-canary` binary for this runner, returning `undefined` when no
 * prebuilt asset applies so the caller can fall back to `cargo install`.
 *
 * Returning `undefined` is the deliberate compatibility path: the engine may
 * not publish prebuilt assets for a release yet, or may not support the
 * runner's architecture. Once a matching asset *is* advertised, a failed
 * download, checksum mismatch, extraction failure, or version mismatch is a
 * real installation failure and throws instead of silently rebuilding.
 */
async function installFromPrebuilt(resolved: ResolvedVersion): Promise<InstalledCanary | undefined> {
  let target: string;
  try {
    target = prebuiltTargetOrThrow();
  } catch (error) {
    if (!(error instanceof UnsupportedPlatformError)) {
      throw error;
    }
    core.warning(error.message);
    return undefined;
  }

  const assetName = prebuiltAssetName(resolved.version, target);
  const assets = await fetchReleaseAssets(resolved.version);
  if (assets === undefined) {
    core.debug(`Could not list release assets for Protocol-Canary ${resolved.version}; installing from source.`);
    return undefined;
  }
  const asset = assets.find((candidate) => candidate.name === assetName);
  if (asset === undefined) {
    core.info(
      `Protocol-Canary ${resolved.version} has no prebuilt asset ${assetName}; installing from source with \`cargo install\`.`,
    );
    return undefined;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stellar-canary-prebuilt-"));
  try {
    const archivePath = path.join(tempDir, assetName);
    core.info(`Downloading prebuilt stellar-canary ${resolved.version} for ${target}...`);
    await downloadReleaseAsset(asset.url, archivePath);
    await verifyDownloadedArchive(archivePath, assetName, assets, resolved.version);

    const extracted = path.join(tempDir, "extracted");
    await extractArchive(archivePath, extracted);
    const extractedBinary = findExtractedBinary(extracted);
    if (extractedBinary === undefined) {
      throw new InstallationFailedError(
        `The prebuilt archive ${assetName} did not contain a ${binaryName()} executable.`,
      );
    }
    if (process.platform !== "win32") {
      fs.chmodSync(extractedBinary, 0o755);
    }
    const version = await getInstalledVersion(extractedBinary);
    if (version === undefined) {
      throw new InstallationFailedError(
        `Downloaded prebuilt stellar-canary from ${assetName} could not be executed to verify its version.`,
      );
    }
    if (version !== resolved.version) {
      throw new InstallationFailedError(
        `Prebuilt stellar-canary from ${assetName} reports version ${version}, but ${resolved.version} was requested.`,
      );
    }

    const installDir = prebuiltInstallDir(resolved.version, target);
    fs.mkdirSync(installDir, { recursive: true });
    const binaryPath = path.join(installDir, binaryName());
    fs.copyFileSync(extractedBinary, binaryPath);
    if (process.platform !== "win32") {
      fs.chmodSync(binaryPath, 0o755);
    }
    core.addPath(installDir);
    core.info(`Installed prebuilt stellar-canary ${version} at ${binaryPath}.`);
    await saveToCache(resolved, binaryPath);
    return { binaryPath, version };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Verifies an installed or cached binary against the checksum published with
 * its release, when one exists. When Protocol-Canary has not published a
 * checksum (or none applies to this platform) this degrades to a debug log
 * and the existing commit/tag pinning stands — see SECURITY.md. A mismatch
 * always throws, so a tampered binary is never trusted.
 */
async function verifyInstalledBinary(binaryPath: string, resolved: ResolvedVersion): Promise<void> {
  const checksums = await lookupPublishedChecksums(resolved.version);
  if (checksums === undefined) {
    core.debug(
      `No published checksum manifest for Protocol-Canary ${resolved.version}; ` +
        "relying on commit/tag pinning only (see SECURITY.md).",
    );
    return;
  }
  const expected = selectExpectedChecksum(checksums, binaryName());
  if (expected === undefined) {
    core.debug(
      `Published checksum manifest for Protocol-Canary ${resolved.version} has no entry for this platform; ` +
        "relying on commit/tag pinning only.",
    );
    return;
  }
  const actual = await sha256File(binaryPath);
  if (actual !== expected) {
    throw new InstallationFailedError(
      `Checksum verification failed for stellar-canary ${resolved.version}: expected SHA-256 ${expected}, ` +
        `but the binary at ${binaryPath} hashes to ${actual}. Refusing to use it (see SECURITY.md).`,
    );
  }
  core.info(`Verified stellar-canary ${resolved.version} against the published SHA-256 checksum.`);
}

/**
 * Runs `<binaryPath> version` and extracts the reported version string.
 * This is the single source of truth for every "does an existing or cached
 * binary actually match the request?" decision in the install chain.
 * Returns `undefined` when the binary cannot be executed or exits non-zero,
 * which callers treat as "not usable" and fall through to the next step.
 */
async function getInstalledVersion(binaryPath: string): Promise<string | undefined> {
  try {
    let stdout = "";
    const result = await exec.exec(binaryPath, ["version"], {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
      },
    });
    if (result !== 0) {
      return undefined;
    }
    // "stellar-canary 0.1.0"
    const match = /stellar-canary\s+(\S+)/.exec(stdout);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Looks for an already-installed binary in the cargo bin directory. Only an
 * exact version match counts: a binary reporting any other version returns
 * `undefined` so the caller falls through to the cache/install steps rather
 * than running the wrong Canary.
 */
async function findExisting(resolved: ResolvedVersion): Promise<InstalledCanary | undefined> {
  const candidatePath = path.join(cargoBinDir(), binaryName());
  if (!fs.existsSync(candidatePath)) {
    return undefined;
  }
  const version = await getInstalledVersion(candidatePath);
  if (version === resolved.version) {
    core.info(`Found stellar-canary ${version} already installed at ${candidatePath}.`);
    return { binaryPath: candidatePath, version };
  }
  return undefined;
}

/**
 * Derives the cache key for a resolved version. The immutable commit SHA is
 * preferred over the tag so a re-pointed tag can never alias a cached build
 * produced from a different commit.
 */
function cacheKeyFor(resolved: ResolvedVersion): string {
  const pin = resolved.commitSha ?? resolved.tag;
  return `stellar-canary-${process.platform}-${process.arch}-${pin}`;
}

/**
 * Attempts to restore a previously built binary from the Actions cache.
 * Returns `undefined` — always falling through to a fresh install — when the
 * cache is unavailable, there is no hit, the restored binary's version does
 * not match, or the restore throws. Caching is a pure optimization, so a
 * failure here is never surfaced as an error.
 */
async function restoreFromCache(resolved: ResolvedVersion): Promise<InstalledCanary | undefined> {
  if (!cache.isFeatureAvailable()) {
    return undefined;
  }
  const binaryPath = path.join(cargoBinDir(), binaryName());
  const key = cacheKeyFor(resolved);
  try {
    const hit = await cache.restoreCache([binaryPath], key);
    if (hit === undefined) {
      return undefined;
    }
    const version = await getInstalledVersion(binaryPath);
    if (version !== resolved.version) {
      core.debug(`Cache hit for ${key} did not produce a matching stellar-canary version; ignoring.`);
      return undefined;
    }
    core.info(`Restored stellar-canary ${resolved.version} from cache (key: ${key}).`);
    return { binaryPath, version };
  } catch (error) {
    core.debug(`Cache restore failed, continuing without it: ${String(error)}`);
    return undefined;
  }
}

/**
 * Saves a freshly built `stellar-canary` binary to the Actions cache so a
 * later run pinned to the same commit (or tag) can skip `cargo install`.
 *
 * The cache key comes from {@link cacheKeyFor}, which embeds the platform,
 * architecture and immutable pin. This is strictly a performance
 * optimization and is deliberately silent about failure: every error —
 * including `@actions/cache` throwing when a save conflicts with an existing
 * entry — is swallowed after a `core.debug` log, so a cache outage never
 * turns a successful install into a failed run. Restored binaries are still
 * re-verified by {@link verifyInstalledBinary} in
 * {@link restoreFromCache}'s caller, so a bad cache entry cannot be trusted.
 *
 * No-ops when {@link cache.isFeatureAvailable} reports the cache service is
 * not reachable from this workflow (for example a fork PR without a
 * `GITHUB_TOKEN` with cache access).
 *
 * @param resolved - The version pin the binary was installed for; used to
 * derive the cache key.
 * @param binaryPath - Absolute path to the verified `stellar-canary` binary
 * to store.
 */
async function saveToCache(resolved: ResolvedVersion, binaryPath: string): Promise<void> {
  if (!cache.isFeatureAvailable()) {
    return;
  }
  try {
    await cache.saveCache([binaryPath], cacheKeyFor(resolved));
  } catch (error) {
    // Caching is a pure optimization; correctness never depends on it.
    core.debug(`Cache save failed, ignoring: ${String(error)}`);
  }
}

/**
 * Verifies the `cargo` toolchain is on the PATH before attempting a source
 * install. Throws an {@link InstallationFailedError} with remediation
 * guidance (rather than a generic error) when it is missing, so the failure
 * is reported as an install problem the user can act on.
 */
async function ensureCargoAvailable(): Promise<void> {
  try {
    await exec.exec("cargo", ["--version"], { silent: true });
  } catch (error) {
    throw new InstallationFailedError(
      "The `cargo` command was not found on this runner, and no prebuilt Protocol-Canary binary " +
        "was available for this release and platform, so this Action needs to install it from source " +
        "with `cargo install`. GitHub-hosted Ubuntu runners include a Rust toolchain by default; on a " +
        "self-hosted or non-Ubuntu runner, install one first (for example with `dtolnay/rust-toolchain`).\n" +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Builds the `cargo install` argument array for the resolved version. */
function buildInstallArgs(resolved: ResolvedVersion): string[] {
  const args = ["install", "--git", CANARY_REPO_URL, "--locked"];
  if (resolved.commitSha !== undefined) {
    args.push("--rev", resolved.commitSha);
  } else {
    core.warning(
      `Could not resolve tag ${resolved.tag} to an immutable commit; installing from the tag directly. ` +
        "This is weaker integrity pinning than usual (see SECURITY.md).",
    );
    args.push("--tag", resolved.tag);
  }
  args.push("canary-cli");
  return args;
}

/** Maps a `runCheck` rejection onto the install-failure error taxonomy. */
function describeInstallFailure(error: unknown, timeoutMs: number, resolved: ResolvedVersion): Error {
  if (error instanceof TimeoutError) {
    return new InstallationFailedError(
      `\`cargo install\` for Protocol-Canary ${resolved.version} timed out after ` +
        `${String(Math.round(timeoutMs / 1000))}s and was terminated. ` +
        "This is usually a stalled network connection or an extremely slow build on the runner. " +
        "Re-run the job, or raise the Action's `timeout-minutes` input if a build of this size " +
        "legitimately needs longer.",
    );
  }
  if (error instanceof CanaryExecutionFailedError) {
    return new InstallationFailedError(
      `Failed to start \`cargo install\` for Protocol-Canary ${resolved.version}: ${error.message}`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Time bound for the `cargo install` process: the Action's own
 * `timeout-minutes` input, floored at one minute so a check-only timeout
 * set below it cannot break installation. `cargo install` clones a git
 * repository and builds it from source, so a hung network fetch or a stuck
 * build must be terminated by this Action's own timeout path (which
 * reports a clear, Canary-specific error) rather than burning runner
 * minutes until GitHub's much longer job-level timeout steps in.
 */
export function cargoInstallTimeoutMs(timeoutMinutes: number): number {
  return Math.max(timeoutMinutes * 60_000, CARGO_INSTALL_TIMEOUT_FLOOR_MS);
}

/**
 * Installs Canary from source with `cargo install --git --locked`, pinned to
 * the resolved commit when available and otherwise to the tag (with a
 * visible warning about the weaker integrity pinning). The process is
 * bounded by `timeoutMs` so a hung clone or build is terminated instead of
 * blocking the job. Throws an {@link InstallationFailedError} on a non-zero
 * exit code, a timeout, or a `cargo` that cannot be started.
 */
async function cargoInstall(resolved: ResolvedVersion, timeoutMs: number): Promise<void> {
  const args = buildInstallArgs(resolved);

  core.info(`Installing stellar-canary ${resolved.version} with: cargo ${args.join(" ")}`);
  // The install is executed through the same bounded runner as
  // `stellar-canary check` so it can never hang indefinitely: the timeout
  // terminates a hung process (SIGTERM, then SIGKILL after the grace
  // period) instead of leaving the job blocked until GitHub's job-level
  // timeout (see issue #65).
  let execution: CheckExecutionResult;
  try {
    execution = await runCheck("cargo", args, timeoutMs);
  } catch (error) {
    throw describeInstallFailure(error, timeoutMs, resolved);
  }
  if (execution.exitCode !== 0) {
    throw new InstallationFailedError(
      `\`cargo install\` exited with code ${String(execution.exitCode)} while installing ` +
        `Protocol-Canary ${resolved.version}.`,
    );
  }
}

/**
 * Ensures a `stellar-canary` binary matching `resolved.version` is
 * available, in order: an already-installed matching binary, a cached
 * build, or a fresh `cargo install` pinned to the resolved commit (falling
 * back to the tag if the commit could not be resolved). Never silently
 * falls back to a different version.
 *
 * The install step is bounded by `installTimeoutMs` and terminated when it
 * exceeds it.
 */
export async function ensureCanaryInstalled(
  resolved: ResolvedVersion,
  installTimeoutMs: number = cargoInstallTimeoutMs(15),
): Promise<InstalledCanary> {
  const existing = await findExisting(resolved);
  if (existing !== undefined) {
    await verifyInstalledBinary(existing.binaryPath, resolved);
    return existing;
  }

  const cached = await restoreFromCache(resolved);
  if (cached !== undefined) {
    await verifyInstalledBinary(cached.binaryPath, resolved);
    return cached;
  }

  // Prebuilt release binaries cut install time from minutes (a Rust build)
  // to seconds. When no asset applies to this release or runner, the helper
  // returns undefined and the source install below remains the fallback.
  const prebuilt = await installFromPrebuilt(resolved);
  if (prebuilt !== undefined) {
    return prebuilt;
  }

  await ensureCargoAvailable();
  await cargoInstall(resolved, installTimeoutMs);

  const binaryPath = path.join(cargoBinDir(), binaryName());
  const version = await getInstalledVersion(binaryPath);
  if (version === undefined) {
    throw new CanaryNotFoundError(
      `cargo install reported success, but no working stellar-canary binary was found at ${binaryPath}.`,
    );
  }
  if (version !== resolved.version) {
    throw new InstallationFailedError(
      `Installed stellar-canary reports version ${version}, but ${resolved.version} was requested.`,
    );
  }

  await verifyInstalledBinary(binaryPath, resolved);
  await saveToCache(resolved, binaryPath);
  return { binaryPath, version };
}
