import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

import { CanaryNotFoundError, InstallationFailedError } from "./errors";
import { CANARY_API_REPO_URL, CANARY_REPO_URL, ResolvedVersion } from "./version";

export interface InstalledCanary {
  readonly binaryPath: string;
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

/** Chooses the manifest entry that corresponds to the binary this runner
 * will execute, preferring an exact file-name match and falling back to a
 * platform match when the manifest names per-target artifacts. */
function selectExpectedChecksum(entries: Map<string, string>, binary: string): string | undefined {
  const exact = entries.get(binary);
  if (exact !== undefined) {
    return exact;
  }
  const candidates = [...entries.entries()].filter(([name]) => name.includes("stellar-canary"));
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

function cacheKeyFor(resolved: ResolvedVersion): string {
  const pin = resolved.commitSha ?? resolved.tag;
  return `stellar-canary-${process.platform}-${process.arch}-${pin}`;
}

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

async function ensureCargoAvailable(): Promise<void> {
  try {
    await exec.exec("cargo", ["--version"], { silent: true });
  } catch (error) {
    throw new InstallationFailedError(
      "The `cargo` command was not found on this runner. Protocol-Canary does not yet publish " +
        "prebuilt release binaries, so this Action installs it from source with `cargo install`. " +
        "GitHub-hosted Ubuntu runners include a Rust toolchain by default; on a self-hosted or " +
        "non-Ubuntu runner, install one first (for example with `dtolnay/rust-toolchain`).\n" +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function cargoInstall(resolved: ResolvedVersion): Promise<void> {
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

  core.info(`Installing stellar-canary ${resolved.version} with: cargo ${args.join(" ")}`);
  const exitCode = await exec.exec("cargo", args, { ignoreReturnCode: true });
  if (exitCode !== 0) {
    throw new InstallationFailedError(
      `\`cargo install\` exited with code ${String(exitCode)} while installing Protocol-Canary ${resolved.version}.`,
    );
  }
}

/**
 * Ensures a `stellar-canary` binary matching `resolved.version` is
 * available, in order: an already-installed matching binary, a cached
 * build, or a fresh `cargo install` pinned to the resolved commit (falling
 * back to the tag if the commit could not be resolved). Never silently
 * falls back to a different version.
 */
export async function ensureCanaryInstalled(resolved: ResolvedVersion): Promise<InstalledCanary> {
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

  await ensureCargoAvailable();
  await cargoInstall(resolved);

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
