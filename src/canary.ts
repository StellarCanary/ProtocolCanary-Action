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
