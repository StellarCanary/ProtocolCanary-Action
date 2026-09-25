import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cacheMocks = vi.hoisted(() => ({
  isFeatureAvailableMock: vi.fn(),
  restoreCacheMock: vi.fn(),
  saveCacheMock: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  infoMock: vi.fn(),
  debugMock: vi.fn(),
  warningMock: vi.fn(),
}));

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));

// `@actions/cache`, `@actions/exec`, and `@actions/core` are all mocked so
// every test in this file is offline and deterministic: no GitHub cache
// service, no Rust toolchain, and no real `stellar-canary` binary is ever
// needed (see the issue's "fully mocked" requirement).
vi.mock("@actions/cache", () => ({
  isFeatureAvailable: cacheMocks.isFeatureAvailableMock,
  restoreCache: cacheMocks.restoreCacheMock,
  saveCache: cacheMocks.saveCacheMock,
}));

vi.mock("@actions/core", () => ({
  info: coreMocks.infoMock,
  debug: coreMocks.debugMock,
  warning: coreMocks.warningMock,
}));

vi.mock("@actions/exec", () => ({
  exec: execMock,
}));

import { ensureCanaryInstalled } from "../../src/canary";
import { CanaryNotFoundError, InstallationFailedError } from "../../src/errors";
import type { ResolvedVersion } from "../../src/version";
import { CANARY_REPO_URL } from "../../src/version";

interface ExecCallOptions {
  readonly ignoreReturnCode?: boolean;
  readonly silent?: boolean;
  readonly listeners?: { readonly stdout?: (data: Buffer) => void };
}

interface ExecCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ExecCallOptions;
}

const RESOLVED: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };

describe("ensureCanaryInstalled", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;
  let execCalls: ExecCall[];
  let versionProbeResults: string[];
  let versionProbeExitCode: number;
  let cargoVersionFails: boolean;
  let installExitCode: number;

  function binaryPath(): string {
    return path.join(tempCargoHome, "bin", process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary");
  }

  function installCalls(): ExecCall[] {
    return execCalls.filter((call) => call.command === "cargo" && call.args[0] === "install");
  }

  /** The `cargo install` argument array from the single install call. */
  function installArgs(): readonly string[] {
    const call = installCalls()[0];
    if (call === undefined) {
      throw new Error("cargo install was never invoked");
    }
    return call.args;
  }

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-cargo-home-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    process.env.CARGO_HOME = tempCargoHome;

    execCalls = [];
    versionProbeResults = [];
    versionProbeExitCode = 0;
    cargoVersionFails = false;
    installExitCode = 0;

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(false);
    cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
    cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();

    execMock.mockReset();
    execMock.mockImplementation(
      async (command: string, args: string[] = [], options: ExecCallOptions = {}): Promise<number> => {
        execCalls.push({ command, args: [...args], options });

        if (command === "cargo" && args[0] === "--version") {
          if (cargoVersionFails) {
            throw new Error("cargo: command not found");
          }
          return 0;
        }
        if (command === "cargo" && args[0] === "install") {
          return installExitCode;
        }

        // The version probe runs the candidate binary.
        const version = versionProbeResults.shift() ?? "0.1.0";
        options.listeners?.stdout?.(Buffer.from(`stellar-canary ${version}\n`));
        return versionProbeExitCode;
      },
    );
  });

  afterEach(() => {
    if (originalCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = originalCargoHome;
    }
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  it("uses an already-installed binary when its version matches, without installing anything", async () => {
    fs.writeFileSync(binaryPath(), "binary");

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0" });
    expect(installCalls()).toHaveLength(0);
    expect(cacheMocks.restoreCacheMock).not.toHaveBeenCalled();
  });

  it("does not reuse an already-installed binary with a different version", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    // The first version probe (the already-installed binary) reports a
    // stale version; after reinstalling, the probe reports the requested one.
    versionProbeResults = ["0.0.9", "0.1.0"];

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0" });
    expect(installCalls()).toHaveLength(1);
  });

  it("installs with `--rev <sha>` when the tag was resolved to a commit", async () => {
    await ensureCanaryInstalled(RESOLVED);

    expect(installArgs()).toEqual([
      "install",
      "--git",
      CANARY_REPO_URL,
      "--locked",
      "--rev",
      "abc123",
      "canary-cli",
    ]);
    expect(coreMocks.warningMock).not.toHaveBeenCalled();
  });

  it("installs with `--tag <tag>` and warns when the commit could not be resolved", async () => {
    await ensureCanaryInstalled({ ...RESOLVED, commitSha: undefined });

    expect(installArgs()).toEqual(["install", "--git", CANARY_REPO_URL, "--locked", "--tag", "v0.1.0", "canary-cli"]);
    expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("installing from the tag directly"));
  });

  it("builds the cache key from the resolved pin and the runner platform", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);

    await ensureCanaryInstalled(RESOLVED);

    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith(
      [binaryPath()],
      `stellar-canary-${process.platform}-${process.arch}-abc123`,
    );
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith(
      [binaryPath()],
      `stellar-canary-${process.platform}-${process.arch}-abc123`,
    );
  });

  it("ignores a cache hit whose binary has the wrong version", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    cacheMocks.restoreCacheMock.mockResolvedValue("cache-key");
    versionProbeResults = ["0.0.9", "0.1.0"];

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.version).toBe("0.1.0");
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("did not produce a matching"));
    expect(installCalls()).toHaveLength(1);
  });

  it("continues without the cache when restoring it fails", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    cacheMocks.restoreCacheMock.mockRejectedValue(new Error("cache service unavailable"));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.version).toBe("0.1.0");
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("Cache restore failed"));
    expect(installCalls()).toHaveLength(1);
  });

  it("rejects with InstallationFailedError when cargo is unavailable", async () => {
    cargoVersionFails = true;

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(InstallationFailedError);
    expect(installCalls()).toHaveLength(0);

    try {
      await ensureCanaryInstalled(RESOLVED);
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationFailedError);
      const message = (error as InstallationFailedError).message;
      expect(message).toContain("The `cargo` command was not found on this runner");
      expect(message).toContain("dtolnay/rust-toolchain");
    }
  });

  it("rejects when `cargo install` exits non-zero", async () => {
    installExitCode = 7;

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(InstallationFailedError);
  });

  it("rejects with CanaryNotFoundError when no working binary appears after install", async () => {
    versionProbeExitCode = 1;

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(CanaryNotFoundError);
  });

  it("does not touch the cache at all when the cache feature is unavailable", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(false);

    await ensureCanaryInstalled(RESOLVED);

    expect(cacheMocks.restoreCacheMock).not.toHaveBeenCalled();
    expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
  });
});
