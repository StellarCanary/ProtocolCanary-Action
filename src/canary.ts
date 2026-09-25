import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CanaryNotFoundError, InstallationFailedError } from "./errors";
import { CANARY_REPO_URL, ResolvedVersion } from "./version";

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
 * Best-effort stores a freshly installed binary under the version's cache
 * key. Returns nothing and never throws: a failed save only loses the
 * optimization for later runs, so it is logged at debug level and ignored.
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
      "The `cargo` command was not found on this runner. Protocol-Canary does not yet publish " +
        "prebuilt release binaries, so this Action installs it from source with `cargo install`. " +
        "GitHub-hosted Ubuntu runners include a Rust toolchain by default; on a self-hosted or " +
        "non-Ubuntu runner, install one first (for example with `dtolnay/rust-toolchain`).\n" +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Installs Canary from source with `cargo install --git --locked`, pinned to
 * the resolved commit when available and otherwise to the tag (with a
 * visible warning about the weaker integrity pinning). Throws an
 * {@link InstallationFailedError} on a non-zero exit code.
 */
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
    return existing;
  }

  const cached = await restoreFromCache(resolved);
  if (cached !== undefined) {
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

  await saveToCache(resolved, binaryPath);
  return { binaryPath, version };
}
