import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
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

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

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

// `cargo install` runs through the bounded `runCheck` runner, which spawns
// the process directly. The spawn is mocked here: the real-process timeout
// behavior of `runCheck` is covered by runner.test.ts against the
// mock-canary fixture; these tests only assert what `ensureCanaryInstalled`
// passes to it and how it interprets the outcome.
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  CARGO_INSTALL_TIMEOUT_FLOOR_MS,
} from "../../src/runner";
import { cargoInstallTimeoutMs, ensureCanaryInstalled } from "../../src/canary";
import { CanaryNotFoundError, InstallationFailedError } from "../../src/errors";
import { CANARY_REPO_URL, ResolvedVersion } from "../../src/version";

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

/** A spawn result that closes immediately with the given exit code. */
class ImmediateChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(exitCode: number) {
    super();
    queueMicrotask(() => this.emit("close", exitCode, null));
  }

  kill(): boolean {
    return true;
  }
}

/** A spawn result that stays alive until it is signalled (a "hung install"). */
class HungChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  /** Whether the fake process exits in response to `SIGTERM` (rather than ignoring it). */
  constructor(private readonly exitsOnSigterm: boolean) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    const exits = this.exitsOnSigterm ? signal === "SIGTERM" : signal === "SIGKILL";
    if (exits) {
      this.emit("close", null, signal);
    }
    return true;
  }
}

describe("cargoInstallTimeoutMs", () => {
  it("derives the bound from timeout-minutes", () => {
    expect(cargoInstallTimeoutMs(15)).toBe(15 * 60_000);
    expect(cargoInstallTimeoutMs(1)).toBe(60_000);
  });

  it("floors the bound at one minute so a tiny check timeout cannot break installs", () => {
    expect(cargoInstallTimeoutMs(0)).toBe(CARGO_INSTALL_TIMEOUT_FLOOR_MS);
    // Fractional minutes would never come from the validated input, but the
    // floor must hold regardless.
    expect(cargoInstallTimeoutMs(0.5)).toBe(CARGO_INSTALL_TIMEOUT_FLOOR_MS);
  });
});

describe("ensureCanaryInstalled", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;
  let execCalls: ExecCall[];
  let versionProbeResults: string[];
  let versionProbeExitCode: number;
  let cargoVersionFails: boolean;

  function binaryPath(): string {
    return path.join(tempCargoHome, "bin", process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary");
  }

  /** The `cargo install` argument array from the single install spawn. */
  function installArgs(): readonly string[] {
    const call = spawnMock.mock.calls.find(
      (call) => call[0] === "cargo" && (call[1] as string[])[0] === "install",
    );
    if (call === undefined) {
      throw new Error("cargo install was never spawned");
    }
    return call[1] as readonly string[];
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

        // The version probe runs the candidate binary.
        const version = versionProbeResults.shift() ?? "0.1.0";
        options.listeners?.stdout?.(Buffer.from(`stellar-canary ${version}\n`));
        return versionProbeExitCode;
      },
    );

    spawnMock.mockReset();
    // Default: a successful, immediately-exiting install process.
    spawnMock.mockImplementation(() => new ImmediateChild(0) as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(spawnMock).not.toHaveBeenCalled();
    expect(cacheMocks.restoreCacheMock).not.toHaveBeenCalled();
  });

  it("does not reuse an already-installed binary with a different version", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    // The first version probe (the already-installed binary) reports a
    // stale version; after reinstalling, the probe reports the requested one.
    versionProbeResults = ["0.0.9", "0.1.0"];

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0" });
    expect(installArgs()[0]).toBe("install");
  });

  it("installs via a spawned `cargo install` rather than @actions/exec", async () => {
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
    // The install must go through the bounded runner; @actions/exec has no
    // timeout support and is used only for the quick version probes.
    expect(execCalls.some((call) => call.args[0] === "install")).toBe(false);
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
    expect(installArgs()[0]).toBe("install");
  });

  it("continues without the cache when restoring it fails", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    cacheMocks.restoreCacheMock.mockRejectedValue(new Error("cache service unavailable"));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.version).toBe("0.1.0");
    expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("Cache restore failed"));
    expect(installArgs()[0]).toBe("install");
  });

  it("rejects with InstallationFailedError when cargo is unavailable", async () => {
    cargoVersionFails = true;

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(InstallationFailedError);
    expect(spawnMock).not.toHaveBeenCalled();

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
    spawnMock.mockImplementation(() => new ImmediateChild(7) as unknown as ChildProcess);

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

describe("ensureCanaryInstalled install timeout (issue #65)", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-cargo-home-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    process.env.CARGO_HOME = tempCargoHome;

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(false);
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();

    execMock.mockReset();
    execMock.mockImplementation(
      async (command: string, args: string[] = [], options: ExecCallOptions = {}): Promise<number> => {
        if (command === "cargo" && args[0] === "--version") {
          return 0;
        }
        // The version probe reports the requested version so the flow
        // reaches the assertions without unrelated failures.
        options.listeners?.stdout?.(Buffer.from(`stellar-canary ${RESOLVED.version}\n`));
        return 0;
      },
    );

    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = originalCargoHome;
    }
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  it("terminates a hung install at the given bound instead of hanging indefinitely", async () => {
    // The child stays alive (a hung `cargo install`) but exits on SIGTERM.
    const hung = new HungChild(true);
    spawnMock.mockImplementation(() => hung as unknown as ChildProcess);

    const pending = ensureCanaryInstalled(RESOLVED, 20);

    await expect(pending).rejects.toThrow(InstallationFailedError);
    await pending.catch((error: InstallationFailedError) => {
      expect(error.message).toContain("timed out");
      expect(error.message).toContain("cargo install");
    });
    expect(hung.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when the hung install ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const hung = new HungChild(false);
    spawnMock.mockImplementation(() => hung as unknown as ChildProcess);

    const pending = ensureCanaryInstalled(RESOLVED, CARGO_INSTALL_TIMEOUT_FLOOR_MS);
    // Attach the rejection handler before advancing the fake clock, so the
    // rejection is never momentarily unhandled when the timer fires.
    const rejected = expect(pending).rejects.toThrow(InstallationFailedError);
    // Fake timers drive runCheck's real timeout and SIGKILL-grace timers:
    // advancing one bound's worth fires the timeout (SIGTERM), arms the
    // grace timer, and then fires it too (SIGKILL) once the child ignores
    // SIGTERM.
    await vi.advanceTimersByTimeAsync(CARGO_INSTALL_TIMEOUT_FLOOR_MS + 5_000 + 1);
    vi.useRealTimers();

    await rejected;
    expect(hung.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not time out a prompt install", async () => {
    spawnMock.mockImplementation(() => new ImmediateChild(0) as unknown as ChildProcess);

    const installed = await ensureCanaryInstalled(RESOLVED, CARGO_INSTALL_TIMEOUT_FLOOR_MS);

    expect(installed.version).toBe(RESOLVED.version);
  });
});
