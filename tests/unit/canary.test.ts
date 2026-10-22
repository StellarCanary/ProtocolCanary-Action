import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import type * as osModule from "node:os";
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
  startGroupMock: vi.fn(),
  endGroupMock: vi.fn(),
  addPathMock: vi.fn(),
}));

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// The GitHub REST calls made while looking up a published checksum are
// stubbed too: no test in this file may hit the network.
const httpsGetMock = vi.hoisted(() => vi.fn());

// `node:os` is mocked (spreading the real module, overriding only `homedir`)
// so the `cargoBinDir` home-directory fallback can be observed against a
// sentinel instead of the runner's real home, which varies by machine.
const osMocks = vi.hoisted(() => ({ homedirMock: vi.fn() }));

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
  startGroup: coreMocks.startGroupMock,
  endGroup: coreMocks.endGroupMock,
  addPath: coreMocks.addPathMock,
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

vi.mock("node:https", () => ({
  get: httpsGetMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>();
  return { ...actual, homedir: osMocks.homedirMock };
});

import {
  cargoInstallTimeoutMs,
  ensureCanaryInstalled,
  getReleaseAssetName,
  prebuiltTargetTriple,
  selectExpectedChecksum,
} from "../../src/canary";
import { CARGO_INSTALL_TIMEOUT_FLOOR_MS } from "../../src/runner";
import { CanaryNotFoundError, InstallationFailedError } from "../../src/errors";
import { REDACTED } from "../../src/redact";
import type { ResolvedVersion } from "../../src/version";
import { CANARY_API_REPO_URL, CANARY_REPO_URL } from "../../src/version";

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

  constructor(exitCode: number, stdoutText = "", stderrText = "") {
    super();
    if (stdoutText !== "") {
      this.stdout.write(stdoutText);
    }
    this.stdout.end();
    if (stderrText !== "") {
      this.stderr.write(stderrText);
    }
    this.stderr.end();
    setImmediate(() => this.emit("close", exitCode, null));
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
  constructor(private readonly exitsOnSigterm: boolean, stdoutText = "", stderrText = "") {
    super();
    if (stdoutText !== "") {
      this.stdout.write(stdoutText);
    }
    if (stderrText !== "") {
      this.stderr.write(stderrText);
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    const exits = this.exitsOnSigterm ? signal === "SIGTERM" : signal === "SIGKILL";
    if (exits) {
      this.stdout.end();
      this.stderr.end();
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

// Sentinel home served by the os.homedir mock: any path that reached
// cargoBinDir's homedir fallback would contain this marker rather than the
// runner's real home, which varies by machine.
const FAKE_HOME = path.join(os.tmpdir(), "protocolcanary-not-the-real-home");

/** The binary name binaryName() picks on the runner this suite executes on. */
function platformBinaryName(): string {
  return process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary";
}

/**
 * Overrides `process.platform` for the duration of `run`, awaiting an async
 * body so the override spans the whole awaited execution (a synchronous
 * try/finally would restore the value as soon as `run` returned its pending
 * promise, before the body finished). On Node >= 20 `process.platform` is a
 * non-writable but configurable data property, so
 * `vi.spyOn(process, "platform", "get")` cannot be used; redefine it and
 * always restore, even when the body throws.
 */
async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true, enumerable: true, writable: false });
  try {
    return await run();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(process, "platform", original);
    }
  }
}

class FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string> = {};
  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
  setEncoding(): void {
    /* no-op for this fake */
  }
  resume(): void {
    /* no-op for this fake */
  }
}

class FakeRequest extends EventEmitter {
  destroy(error?: Error): void {
    if (error) {
      this.emit("error", error);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function respond(statusCode: number, body: string): any {
  return (_url: string, _options: unknown, callback: (response: FakeResponse) => void) => {
    const response = new FakeResponse(statusCode);
    const request = new FakeRequest();
    callback(response);
    queueMicrotask(() => {
      response.emit("data", body);
      response.emit("end");
    });
    return request;
  };
}

function simulateRequestTimeout(): FakeRequest {
  const request = new FakeRequest();
  queueMicrotask(() => request.emit("timeout"));
  return request;
}

/** Serves a release whose assets include a checksum manifest, then the
 * manifest itself, for the next two GitHub requests. */
function mockPublishedChecksums(manifest: string): void {
  httpsGetMock
    .mockImplementationOnce(
      respond(
        200,
        JSON.stringify({
          assets: [{ name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" }],
        }),
      ),
    )
    .mockImplementationOnce(respond(200, manifest));
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

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
    // No test in this file depends on the runner's real home directory:
    // anything reaching the homedir fallback without overriding the mock
    // sees a sentinel that must not leak into a CARGO_HOME-based path.
    osMocks.homedirMock.mockReset().mockReturnValue(FAKE_HOME);
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();

    // No checksum release by default: every lookup degrades gracefully.
    httpsGetMock.mockReset();
    httpsGetMock.mockImplementation(respond(404, ""));

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

    expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0", origin: "source-build" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(cacheMocks.restoreCacheMock).not.toHaveBeenCalled();
  });

  it("does not reuse an already-installed binary with a different version", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    // The first version probe (the already-installed binary) reports a
    // stale version; after reinstalling, the probe reports the requested one.
    versionProbeResults = ["0.0.9", "0.1.0"];

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0", origin: "source-build" });
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

  // #228: cacheKeyFor is private and zero-argument; its only real branch is
  // the `commitSha ?? tag` precedence. Pinned through the cache key it hands
  // to restore/save — the observable surface it drives — so a regression
  // that let the tag win could never slip through: two different commits
  // under a moving tag would silently share (and poison) one cache entry.
  it("prefers commitSha over tag for the cache key, even when both are present (#228)", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);

    // RESOLVED carries both a tag and a commitSha: the SHA must win.
    await ensureCanaryInstalled(RESOLVED);

    const expected = `stellar-canary-${process.platform}-${process.arch}-abc123`;
    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith([binaryPath()], expected);
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith([binaryPath()], expected);
    // And the tag must not leak into either key at all.
    for (const call of [...cacheMocks.restoreCacheMock.mock.calls, ...cacheMocks.saveCacheMock.mock.calls]) {
      expect(call[1]).not.toContain("v0.1.0");
    }
  });

  it("falls back to the tag for the cache key when commitSha is absent (#228)", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);

    await ensureCanaryInstalled({ ...RESOLVED, commitSha: undefined });

    const expected = `stellar-canary-${process.platform}-${process.arch}-v0.1.0`;
    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith([binaryPath()], expected);
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith([binaryPath()], expected);
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

  it("rejects when `cargo install` exits non-zero and includes stderr diagnostics in the error and log group", async () => {
    const stderrLines = Array.from({ length: 50 }, (_, i) => `cargo error line ${i + 1}`).join("\n");
    spawnMock.mockImplementation(() => new ImmediateChild(101, "compiling deps", stderrLines) as unknown as ChildProcess);

    let caughtError: InstallationFailedError | undefined;
    try {
      await ensureCanaryInstalled(RESOLVED);
    } catch (err) {
      caughtError = err as InstallationFailedError;
    }

    expect(caughtError).toBeInstanceOf(InstallationFailedError);
    expect(caughtError?.message).toContain("`cargo install` exited with code 101");
    // Bounded to last 40 lines
    expect(caughtError?.message).toContain("cargo error line 50");
    expect(caughtError?.message).toContain("cargo error line 11");
    expect(caughtError?.message).not.toContain("cargo error line 10\n");
    expect(caughtError?.message).toContain("[... earlier output truncated ...]");
    expect(caughtError?.diagnostic).toBeDefined();

    // Checked that log blocks were printed
    expect(coreMocks.startGroupMock).toHaveBeenCalledWith("Cargo stdout");
    expect(coreMocks.startGroupMock).toHaveBeenCalledWith("Cargo stderr");
    expect(coreMocks.endGroupMock).toHaveBeenCalledTimes(2);
  });

  it("redacts secrets and removes ANSI escape sequences and control characters from cargo diagnostics", async () => {
    const dirtyStderr = [
      "\x1B[31;1merror[E0425]:\x1B[0m cannot find value `foo`\r",
      "failed with secret seed: SB3W52UQNPILTKJE752GYUDO7PXFYS7PBY4CL5NZW5DXRBG5G3EK7R3N\r",
      "attempted workflow command: ::error::malicious annotation\r",
    ].join("\n");
    spawnMock.mockImplementation(() => new ImmediateChild(101, "", dirtyStderr) as unknown as ChildProcess);

    let caughtError: InstallationFailedError | undefined;
    try {
      await ensureCanaryInstalled(RESOLVED);
    } catch (err) {
      caughtError = err as InstallationFailedError;
    }

    expect(caughtError).toBeInstanceOf(InstallationFailedError);
    const msg = caughtError!.message;

    // ANSI stripped
    expect(msg).not.toContain("\x1B[31;1m");
    expect(msg).toContain("error[E0425]: cannot find value \\`foo\\`");
    // \r removed
    expect(msg).not.toContain("\r");
    // Seed redacted
    expect(msg).not.toContain("SB3W52UQNPILTKJE752GYUDO7PXFYS7PBY4CL5NZW5DXRBG5G3EK7R3N");
    expect(msg).toContain(REDACTED);
    // Command neutralized
    expect(msg).not.toContain("::error::");
    expect(msg).toContain("\\:\\:error\\:\\:");
  });

  it("caps cargo error diagnostic at 8 KiB and includes truncation notice", async () => {
    const hugeStderr = "error: " + "a".repeat(20_000);
    spawnMock.mockImplementation(() => new ImmediateChild(101, "", hugeStderr) as unknown as ChildProcess);

    let caughtError: InstallationFailedError | undefined;
    try {
      await ensureCanaryInstalled(RESOLVED);
    } catch (err) {
      caughtError = err as InstallationFailedError;
    }

    expect(caughtError).toBeInstanceOf(InstallationFailedError);
    expect(caughtError?.diagnostic).toBeDefined();
    expect(Buffer.byteLength(caughtError!.diagnostic!, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(caughtError!.diagnostic).toContain("[... earlier output truncated ...]");
  });

  it("prints nothing new to log groups on successful cargo install", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    spawnMock.mockImplementation(() => new ImmediateChild(0) as unknown as ChildProcess);

    await ensureCanaryInstalled(RESOLVED);

    expect(coreMocks.startGroupMock).not.toHaveBeenCalled();
    expect(coreMocks.endGroupMock).not.toHaveBeenCalled();
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

  // #424: a source build is never compared against a release checksum. The
  // install succeeds with no manifest lookup at all, and reports at info (not
  // debug) that the commit/tag pin is the integrity anchor.
  it("does not compare a source build against a published checksum and logs the pin at info", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    mockPublishedChecksums(`${sha256(binaryPath())}  stellar-canary\n`);

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(installed.origin).toBe("source-build");
    // No manifest lookup is performed for a source build.
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(coreMocks.infoMock).toHaveBeenCalledWith(
      expect.stringContaining("release checksums do not apply to source builds"),
    );
  });

  it("does not fail a source build when a published checksum would not match it (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    // A manifest entry that cannot equal this source build's digest: under the
    // old model this failed every source install; under #424 it is irrelevant.
    mockPublishedChecksums(`${"0".repeat(64)}  stellar-canary\n`);

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(installed.origin).toBe("source-build");
    expect(httpsGetMock).not.toHaveBeenCalled();
  });

  it("does not look up a manifest for a source build even when one is published", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    // beforeEach's default mock returns 404 for every request; regardless of
    // whether a release carries a checksum asset, a source build makes no
    // request and logs the pin.
    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(spawnMock).not.toHaveBeenCalled();
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(coreMocks.infoMock).toHaveBeenCalledWith(
      expect.stringContaining("integrity rests on the commit/tag pin"),
    );
  });

  // #424: a source build performs no manifest lookup, so a redirect, timeout,
  // or malformed release response encountered by the (release-asset only)
  // lookup path cannot affect it. These cases are covered against the lookup
  // itself in the release-asset suite; here we pin that a source install is
  // unaffected by any of them.
  it("is unaffected by a redirected release lookup because it makes no lookup (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock.mockImplementationOnce(respond(302, ""));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(installed.origin).toBe("source-build");
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("is unaffected by a lookup timeout because it makes no lookup (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock.mockImplementationOnce((() => simulateRequestTimeout()) as never);

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("is unaffected by a malformed release response because it makes no lookup (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock.mockImplementationOnce(respond(200, "{not valid JSON"));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("is unaffected by malformed checksum manifest entries because it makes no lookup (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock
      .mockImplementationOnce(
        respond(
          200,
          JSON.stringify({
            assets: [{ name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" }],
          }),
        ),
      )
      .mockImplementationOnce(respond(200, `not-a-digest  ${platformBinaryName()}\n${"a".repeat(63)}  other-binary\n`));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // #424: a source build makes no GitHub request at all, so a configured token
  // is never sent anywhere during a source install. The header behaviour of
  // the lookup itself (Authorization only for api.github.com) is exercised via
  // the release-asset/prebuilt path.
  it("sends no request (and no token) during a source install", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock
      .mockImplementationOnce(
        respond(
          200,
          JSON.stringify({
            assets: [
              {
                name: "SHA256SUMS",
                browser_download_url: "https://github.com/StellarCanary/Protocol-Canary/releases/download/v0.1.0/SHA256SUMS",
              },
            ],
          }),
        ),
      )
      .mockImplementationOnce(
        respond(200, `9a3a45d01531a20e89ac6ae10b0b0beb0492acd7216a368aa062d1a5fecaf9cd  ${platformBinaryName()}\n`),
      );

    const installed = await ensureCanaryInstalled(RESOLVED, undefined, "my-secret-token");

    expect(installed.origin).toBe("source-build");
    expect(httpsGetMock).not.toHaveBeenCalled();
  });

  // #424: selectExpectedChecksum no longer falls back to a platform or
  // single-candidate match. An entry that is not an exact name match for this
  // runner's asset (or binary) is never returned, so a manifest naming only
  // other platforms' binaries yields undefined rather than a wrong-platform
  // digest. (Old #273 contract removed.)
  it("returns undefined when the manifest names only other platforms' binaries (#424)", () => {
    const otherPlatforms = (["darwin", "linux", "win32"] as const).filter(
      (platform) => platform !== process.platform,
    );
    const entries = new Map<string, string>([
      [`stellar-canary-${otherPlatforms[0]}-x64`, "a".repeat(64)],
      [`stellar-canary-${otherPlatforms[1]}-arm64`, "b".repeat(64)],
    ]);

    expect(selectExpectedChecksum(entries, platformBinaryName())).toBeUndefined();
  });

  it("returns the digest only for an exact asset-name match (#424)", () => {
    const digest = "e".repeat(64);
    const entries = new Map<string, string>([
      [`stellar-canary-linux-x86_64`, "a".repeat(64)],
      [getReleaseAssetName(platformBinaryName()), digest],
    ]);

    expect(selectExpectedChecksum(entries, platformBinaryName())).toBe(digest);
  });

  it("never hands this runner a different platform's digest (#424)", () => {
    // A manifest with several per-platform entries but none for this runner:
    // exactly the macOS/Windows-gets-the-Linux-digest hazard the issue names.
    const entries = new Map<string, string>([
      ["stellar-canary-linux-x86_64", "d".repeat(64)],
      ["stellar-canary-macos-x86_64", "e".repeat(64)],
      ["stellar-canary-windows-x86_64", "f".repeat(64)],
    ]);

    const selected = selectExpectedChecksum(entries, platformBinaryName());
    if (selected !== undefined) {
      // If a digest is handed back it must be this runner's own exact entry.
      expect(entries.get(getReleaseAssetName(platformBinaryName()))).toBe(selected);
    }
  });

  // #424: a source build performs no manifest lookup, so manifest parsing
  // (including the #275 comment/binary-mode tolerance) is not exercised from
  // this path. Parsing is covered where it runs — the release-asset/prebuilt
  // verification — and the source install is pinned to make no lookup.
  describe("#275 manifest parsing n/a to source builds (#424)", () => {
    it("never parses a manifest for a source build, even a comment/binary-mode one", async () => {
      fs.writeFileSync(binaryPath(), "binary");
      mockPublishedChecksums(
        `# SHA256 checksums for Protocol-Canary 0.1.0\n` +
          `${sha256(binaryPath())} *${platformBinaryName()}\n` +
          `\n`,
      );

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.origin).toBe("source-build");
      expect(httpsGetMock).not.toHaveBeenCalled();
    });

    it("does not reject a source build even when a *-entry would not match it (#424)", async () => {
      fs.writeFileSync(binaryPath(), "not-the-published-binary");
      mockPublishedChecksums(
        `# generated by release tooling\n${"d".repeat(64)} *${platformBinaryName()}\n`,
      );

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.origin).toBe("source-build");
      expect(httpsGetMock).not.toHaveBeenCalled();
    });
  });

  // #424: the platform-only fallback (#274) is removed. An entry named for the
  // platform but not the exact asset/binary name is never selected.
  describe("#274 platform-only entry is not selected (#424)", () => {
    /** A name matching this runner's platform but with an arch suffix that is
     * never the real process.arch, i.e. not the exact asset name. */
    function platformOnlyName(): string {
      const otherArch = process.arch === "arm64" ? "armv7" : "arm64";
      return `stellar-canary-${process.platform}-${otherArch}`;
    }

    it("does not select a platform-only entry", () => {
      const entries = new Map<string, string>([[platformOnlyName(), "c".repeat(64)]]);

      expect(selectExpectedChecksum(entries, platformBinaryName())).toBeUndefined();
    });

    it("never returns the platform-only digest even when it is the only entry", () => {
      const unrelated = "c".repeat(64);
      const entries = new Map<string, string>([[platformOnlyName(), unrelated]]);

      const selected = selectExpectedChecksum(entries, platformBinaryName());
      expect(selected).not.toBe(unrelated);
      expect(selected).toBeUndefined();
    });
  });

  // #220: cargoBinDir is private and zero-argument, so it is pinned through
  // its only observable effect on the install chain: the directory the
  // candidate binary path is joined onto, as handed to the Actions cache.
  // A regression that dropped CARGO_HOME (or joined the wrong segment) would
  // silently break cache restore/save and existing-binary discovery.
  it("anchors every binary path under CARGO_HOME/bin when CARGO_HOME is set (#220)", async () => {
    process.env.CARGO_HOME = tempCargoHome;
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);

    await ensureCanaryInstalled(RESOLVED);

    const expectedPath = path.join(tempCargoHome, "bin", platformBinaryName());
    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith([expectedPath], expect.any(String));
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith([expectedPath], expect.any(String));
    // The homedir fallback must not be consulted while CARGO_HOME wins.
    expect(osMocks.homedirMock).not.toHaveBeenCalled();
  });

  it("falls back to ~/.cargo/bin when CARGO_HOME is unset (#220)", async () => {
    // beforeEach sets CARGO_HOME; remove it so the helper cannot satisfy
    // itself from the environment and must use the homedir fallback, which
    // the os mock serves as the FAKE_HOME sentinel.
    delete process.env.CARGO_HOME;
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);

    await ensureCanaryInstalled(RESOLVED);

    const expectedPath = path.join(FAKE_HOME, ".cargo", "bin", platformBinaryName());
    expect(cacheMocks.restoreCacheMock).toHaveBeenCalledWith([expectedPath], expect.any(String));
    expect(cacheMocks.saveCacheMock).toHaveBeenCalledWith([expectedPath], expect.any(String));
    expect(osMocks.homedirMock).toHaveBeenCalled();
  });

  // #224: binaryName is private and zero-argument; its only branch is the
  // process.platform check ("stellar-canary.exe" on win32, "stellar-canary"
  // elsewhere). Pinned through the cache-path contract the same way, with
  // the platform overridden so both branches are covered on any runner OS.
  it("names the binary stellar-canary.exe when the platform is win32 (#224)", async () => {
    // The saved cache path is the observation point; enable the cache so
    // saveToCache actually runs (beforeEach disables it).
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    let savedPath: string | undefined;
    await withPlatform("win32", async () => {
      await ensureCanaryInstalled(RESOLVED);
      const call = cacheMocks.saveCacheMock.mock.calls.at(-1);
      savedPath = (call?.[0] as string[] | undefined)?.[0];
    });

    expect(savedPath).toBe(path.join(tempCargoHome, "bin", "stellar-canary.exe"));
  });

  it("names the binary stellar-canary (no .exe) on non-win32 platforms (#224)", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    for (const platform of ["linux", "darwin", "freebsd", "openbsd"] as const) {
      let savedPath: string | undefined;
      await withPlatform(platform, async () => {
        await ensureCanaryInstalled(RESOLVED);
        const call = cacheMocks.saveCacheMock.mock.calls.at(-1);
        savedPath = (call?.[0] as string[] | undefined)?.[0];
      });

      expect(savedPath).toBe(path.join(tempCargoHome, "bin", "stellar-canary"));
    }
  });

  // #354: Test binary cache restoration, cache misses, executable permissions,
  // and corrupted/empty cache fallback
  describe("cache restoration and fallback (#354)", () => {
    async function fallsBackAfterInvalidBinary(contents: string): Promise<void> {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockImplementationOnce(async (paths: string[]) => {
        const restoredPath = paths[0];
        if (restoredPath === undefined) {
          throw new Error("cache restore did not receive a binary path");
        }
        fs.writeFileSync(restoredPath, contents, { mode: 0o755 });
        return "cache-hit-key";
      });
      execMock.mockImplementation(
        async (command: string, args: string[] = [], options: ExecCallOptions = {}): Promise<number> => {
          execCalls.push({ command, args: [...args], options });
          if (command === "cargo" && args[0] === "--version") {
            return 0;
          }
          if (fs.readFileSync(command, "utf8") !== "fresh binary") {
            return 1;
          }
          options.listeners?.stdout?.(Buffer.from(`stellar-canary ${RESOLVED.version}\n`));
          return 0;
        },
      );
      spawnMock.mockImplementation(() => {
        fs.writeFileSync(binaryPath(), "fresh binary", { mode: 0o755 });
        return new ImmediateChild(0) as unknown as ChildProcess;
      });

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed).toEqual({ binaryPath: binaryPath(), version: RESOLVED.version, origin: "source-build" });
      expect(installArgs()[0]).toBe("install");
      expect(fs.readFileSync(binaryPath(), "utf8")).toBe("fresh binary");
      expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("did not produce a matching"));
    }

    it("restores a binary from cache when cache hit occurs", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockImplementationOnce(async (paths: string[]) => {
        const restoredPath = paths[0];
        if (restoredPath === undefined) {
          throw new Error("cache restore did not receive a binary path");
        }
        fs.writeFileSync(restoredPath, "cached binary", { mode: 0o755 });
        fs.chmodSync(restoredPath, 0o755);
        return "cache-hit-key";
      });

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed).toEqual({ binaryPath: binaryPath(), version: RESOLVED.version, origin: "source-build" });
      expect(cacheMocks.restoreCacheMock).toHaveBeenCalledTimes(1);
      expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
      expect(coreMocks.infoMock).toHaveBeenCalledWith(expect.stringContaining("Restored stellar-canary"));
      if (process.platform !== "win32") {
        expect(fs.statSync(binaryPath()).mode & 0o777).toBe(0o755);
      }
    });

    it("falls back to cargo install on cache miss", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockResolvedValue(undefined);

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.version).toBe("0.1.0");
      expect(cacheMocks.restoreCacheMock).toHaveBeenCalledTimes(1);
      expect(cacheMocks.saveCacheMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalled();
    });

    it("falls back to cargo install when restored binary is not executable", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockResolvedValue("cache-hit-key");
      // firstVersionProbeReturns: result for the version check after cache restore
      // The cached binary exists but is not executable, so the probe throws
      let probeCallCount = 0;
      execMock.mockImplementation(
        async (command: string, args: string[] = [], options: ExecCallOptions = {}): Promise<number> => {
          execCalls.push({ command, args: [...args], options });

          if (command === "cargo" && args[0] === "--version") {
            return 0;
          }

          probeCallCount++;
          if (probeCallCount === 1) {
            // First probe (cached binary) throws - not executable
            throw new Error("ENOENT");
          }
          // Second probe (after fresh install) succeeds
          options.listeners?.stdout?.(Buffer.from(`stellar-canary 0.1.0\n`));
          return 0;
        },
      );

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.version).toBe("0.1.0");
      expect(spawnMock).toHaveBeenCalled();
      expect(cacheMocks.saveCacheMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to cargo install when the restored binary is empty", async () => {
      await fallsBackAfterInvalidBinary("");
    });

    it("falls back to cargo install when the restored binary is corrupted", async () => {
      await fallsBackAfterInvalidBinary("corrupted binary");
    });

    it("falls back to cargo install when cache restore throws", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockRejectedValue(new Error("cache restore failed"));

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.version).toBe("0.1.0");
      expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("Cache restore failed"));
      expect(spawnMock).toHaveBeenCalled();
    });

    // #424: a restored cache entry is a source build, so it is not compared
    // against a release checksum; the commit/tag pin is the anchor.
    it("does not compare a restored cache entry against a published checksum (#424)", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockResolvedValue("cache-hit-key");
      fs.writeFileSync(binaryPath(), "binary");
      mockPublishedChecksums(`${sha256(binaryPath())}  stellar-canary\n`);

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.version).toBe("0.1.0");
      expect(installed.origin).toBe("source-build");
      expect(httpsGetMock).not.toHaveBeenCalled();
      expect(coreMocks.infoMock).toHaveBeenCalledWith(
        expect.stringContaining("release checksums do not apply to source builds"),
      );
    });

    it("does not reject a restored cache entry when a published checksum would not match it (#424)", async () => {
      cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
      cacheMocks.restoreCacheMock.mockResolvedValue("cache-hit-key");
      fs.writeFileSync(binaryPath(), "tampered-binary");
      mockPublishedChecksums(`${"a".repeat(64)}  stellar-canary\n`);

      const installed = await ensureCanaryInstalled(RESOLVED);

      expect(installed.origin).toBe("source-build");
      expect(httpsGetMock).not.toHaveBeenCalled();
      expect(coreMocks.debugMock).not.toHaveBeenCalledWith(expect.stringContaining("Cache restore failed"));
    });
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

// ---------------------------------------------------------------------------
// #359 — install engine releases from prebuilt assets when they exist.
// ---------------------------------------------------------------------------

/** Overrides `process.arch` for the duration of `run`, mirroring
 * `withPlatform` above (configurable, non-writable property). */
async function withArch<T>(arch: string, run: () => Promise<T> | T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "arch", { value: arch, configurable: true, enumerable: true, writable: false });
  try {
    return await run();
  } finally {
    if (original !== undefined) {
      Object.defineProperty(process, "arch", original);
    }
  }
}

describe("prebuilt release install (issue #359)", () => {
  it("maps every supported runner platform/arch to the engine release target triple", () => {
    expect(prebuiltTargetTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(prebuiltTargetTriple("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(prebuiltTargetTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(prebuiltTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(prebuiltTargetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
  });

  it("throws a clear unsupported-platform error for pairs with no published target", () => {
    expect(() => prebuiltTargetTriple("linux", "arm")).toThrow(/Unsupported platform linux-arm/);
    expect(() => prebuiltTargetTriple("win32", "arm64")).toThrow(/Unsupported platform win32-arm64/);
    expect(() => prebuiltTargetTriple("freebsd", "x64")).toThrow(/Unsupported platform freebsd-x64/);
    expect(() => prebuiltTargetTriple("linux", "arm")).toThrow(/x86_64-unknown-linux-gnu/);
  });

  describe("inside ensureCanaryInstalled", () => {
    let tempCargoHome: string;
    let originalCargoHome: string | undefined;
    let tempToolCache: string;
    let originalToolCache: string | undefined;
    /** Version strings fed to the exec-mocked `stellar-canary version`
     * probes, mirroring the outer suite's mechanism. */
    let versionProbeResults: string[];
    let versionProbeExitCode: number;

    /** The release asset name the installer looks for on a linux-x64 runner;
     * every flow test pins platform/arch to linux-x64 so it is deterministic
     * on any dev machine or CI host. */
    const LINUX_X64_ASSET = `stellar-canary-${RESOLVED.version}-x86_64-unknown-linux-gnu.tar.gz`;
    /** The name the published manifest actually uses for the linux-x64 binary
     * (what getReleaseAssetName maps to), NOT the archive name. */
    const LINUX_X64_BINARY_NAME = "stellar-canary-linux-x86_64";
    const DOWNLOAD_URL = "https://example.test/prebuilt-download";
    const OBJECTS_URL = "https://objects.githubusercontent.com/signed-asset";
    const MANIFEST_URL = "https://example.test/SHA256SUMS";

    /** The bytes the flat extraction writes for the given archive. */
    function extractedBinaryBytes(archiveName: string): string {
      return `extracted-from-${archiveName}`;
    }

    /** A manifest line proving the extracted linux-x64 binary, keyed by the
     * binary name the release manifest uses (#424). */
    function manifestForExtracted(archiveName: string): string {
      const digest = crypto.createHash("sha256").update(extractedBinaryBytes(archiveName)).digest("hex");
      return `${digest}  ${LINUX_X64_BINARY_NAME}\n`;
    }

    /** Builds a release body carrying the named assets. */
    function releaseBodyWith(assets: { name: string; url: string }[]): string {
      return JSON.stringify({
        assets: assets.map((asset) => ({ name: asset.name, browser_download_url: asset.url })),
      });
    }

    interface PrebuiltServeOptions {
      readonly releaseBody?: string;
      readonly manifestBody?: string | undefined;
      readonly archiveBytes?: Buffer;
      readonly redirectVia?: boolean;
    }

    /** URL-dispatching https mock serving the release API, the checksum
     * manifest, and the asset download (optionally via one redirect hop).
     * With `stopAfterDownload`, every request after the asset download
     * finishes answers 404 — used to pin the prebuilt stage down so a
     * cargo-fallback's later checksum lookup degrades like the outer
     * suite's default instead of re-serving this fixture. */
    function servePrebuiltRelease(options: PrebuiltServeOptions, stopAfterDownload = false): void {
      let downloadServed = false;
      httpsGetMock.mockImplementation(
        ((
          url: string,
          _opts: unknown,
          callback: (response: FakeResponse) => void,
        ): FakeRequest => {
          const request = new FakeRequest();
          const response = new FakeResponse(200);
          if (stopAfterDownload && downloadServed) {
            response.statusCode = 404;
            callback(response);
            queueMicrotask(() => response.emit("end"));
            return request;
          }
          if (url === `${CANARY_API_REPO_URL}/releases/tags/v${RESOLVED.version}`) {
            callback(response);
            queueMicrotask(() => {
              response.emit("data", options.releaseBody ?? "{}");
              response.emit("end");
            });
          } else if (url === MANIFEST_URL) {
            callback(response);
            queueMicrotask(() => {
              response.emit("data", options.manifestBody ?? "");
              response.emit("end");
            });
          } else if (url === DOWNLOAD_URL && options.redirectVia === true) {
            response.statusCode = 302;
            response.headers.location = OBJECTS_URL;
            callback(response);
            queueMicrotask(() => response.emit("end"));
          } else if (url === OBJECTS_URL || (url === DOWNLOAD_URL && options.redirectVia !== true)) {
            callback(response);
            queueMicrotask(() => {
              response.emit("data", options.archiveBytes ?? Buffer.alloc(0));
              response.emit("end");
              downloadServed = true;
            });
          } else {
            response.statusCode = 404;
            callback(response);
            queueMicrotask(() => response.emit("end"));
          }
          return request;
        }) as never,
      );
    }

    /** Exec mock that understands `tar` extraction (simulated by `extract`,
     * which materializes the binary where a real untar would) and answers
     * the version probes from `versionProbeResults`. */
    function mockExecWithFakeTar(extract: (archivePath: string, destDir: string) => void): void {
      execMock.mockImplementation(
        async (command: string, args: string[] = [], options: ExecCallOptions = {}): Promise<number> => {
          if (command === "cargo" && args[0] === "--version") {
            return 0;
          }
          if (command === "tar") {
            extract(args[1] as string, args[3] as string);
            return 0;
          }
          const version = versionProbeResults.shift() ?? "0.1.0";
          options.listeners?.stdout?.(Buffer.from(`stellar-canary ${version}\n`));
          return versionProbeExitCode;
        },
      );
    }

    /** The default fake extraction: a flat layout with the binary directly
     * under the destination directory. */
    function flatExtract(archivePath: string, destDir: string): void {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "stellar-canary"), `extracted-from-${path.basename(archivePath)}`);
    }

    function prebuiltBinaryPath(): string {
      return path.join(tempToolCache, "stellar-canary", RESOLVED.version, "x64", "stellar-canary");
    }

    beforeEach(() => {
      tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-prebuilt-cargo-home-"));
      fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
      originalCargoHome = process.env.CARGO_HOME;
      process.env.CARGO_HOME = tempCargoHome;

      tempToolCache = fs.mkdtempSync(path.join(os.tmpdir(), "canary-prebuilt-toolcache-"));
      originalToolCache = process.env.RUNNER_TOOL_CACHE;
      process.env.RUNNER_TOOL_CACHE = tempToolCache;

      versionProbeResults = [];
      versionProbeExitCode = 0;

      cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(false);
      cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
      cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
      osMocks.homedirMock.mockReset().mockReturnValue(FAKE_HOME);
      coreMocks.infoMock.mockReset();
      coreMocks.debugMock.mockReset();
      coreMocks.warningMock.mockReset();
      coreMocks.addPathMock.mockReset();

      httpsGetMock.mockReset();
      httpsGetMock.mockImplementation(respond(404, ""));

      execMock.mockReset();
      // Same default exec surface as the outer suite: `cargo --version`
      // succeeds and version probes answer from `versionProbeResults`.
      execMock.mockImplementation(
        async (command: string, args: string[] = [], options: ExecCallOptions = {}): Promise<number> => {
          if (command === "cargo" && args[0] === "--version") {
            return 0;
          }
          const version = versionProbeResults.shift() ?? "0.1.0";
          options.listeners?.stdout?.(Buffer.from(`stellar-canary ${version}\n`));
          return versionProbeExitCode;
        },
      );

      spawnMock.mockReset();
      spawnMock.mockImplementation(() => new ImmediateChild(0) as unknown as ChildProcess);
    });

    afterEach(() => {
      if (originalCargoHome === undefined) {
        delete process.env.CARGO_HOME;
      } else {
        process.env.CARGO_HOME = originalCargoHome;
      }
      if (originalToolCache === undefined) {
        delete process.env.RUNNER_TOOL_CACHE;
      } else {
        process.env.RUNNER_TOOL_CACHE = originalToolCache;
      }
      fs.rmSync(tempCargoHome, { recursive: true, force: true });
      fs.rmSync(tempToolCache, { recursive: true, force: true });
    });

    it("installs the checksum-verified prebuilt asset and skips the source build", async () => {
      const archiveBytes = Buffer.from("fake-tar.gz-payload");
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
        manifestBody: manifestForExtracted(LINUX_X64_ASSET),
        archiveBytes,
      });
      mockExecWithFakeTar(flatExtract);

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed).toEqual({ binaryPath: prebuiltBinaryPath(), version: "0.1.0", origin: "release-asset" });
      expect(spawnMock).not.toHaveBeenCalled();
      expect(coreMocks.addPathMock).toHaveBeenCalledWith(path.dirname(prebuiltBinaryPath()));
      expect(coreMocks.infoMock).toHaveBeenCalledWith(
        expect.stringContaining(`prebuilt release asset ${LINUX_X64_ASSET}`),
      );
      expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
    });

    it("follows the CDN redirect when downloading the release asset", async () => {
      const archiveBytes = Buffer.from("redirected-payload");
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
        manifestBody: manifestForExtracted(LINUX_X64_ASSET),
        archiveBytes,
        redirectVia: true,
      });
      mockExecWithFakeTar(flatExtract);

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(prebuiltBinaryPath());
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("places the tool-cache binary under a nested archive layout too", async () => {
      const archiveBytes = Buffer.from("nested-layout");
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
        manifestBody: manifestForExtracted(LINUX_X64_ASSET),
        archiveBytes,
      });
      mockExecWithFakeTar((archive, dest) => {
        const nested = path.join(dest, `stellar-canary-${RESOLVED.version}-x86_64-unknown-linux-gnu`, "bin");
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, "stellar-canary"), extractedBinaryBytes(path.basename(archive)));
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.version).toBe("0.1.0");
      expect(installed.binaryPath).toBe(
        path.join(
          tempToolCache,
          "stellar-canary",
          RESOLVED.version,
          "x64",
          `stellar-canary-${RESOLVED.version}-x86_64-unknown-linux-gnu`,
          "bin",
          "stellar-canary",
        ),
      );
      expect(coreMocks.addPathMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with InstallationFailedError when the asset hash does not match the published checksum", async () => {
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
        manifestBody: `${"f".repeat(64)}  ${LINUX_X64_BINARY_NAME}\n`,
        archiveBytes: Buffer.from("tampered-payload"),
      });
      mockExecWithFakeTar(flatExtract);

      const error = await withPlatform("linux", () =>
        withArch("x64", async () =>
          ensureCanaryInstalled(RESOLVED).then(
            () => {
              throw new Error("expected ensureCanaryInstalled to reject");
            },
            (rejection: unknown) => rejection,
          ),
        ),
      );
      expect(error).toBeInstanceOf(InstallationFailedError);
      expect((error as InstallationFailedError).message).toContain("f".repeat(64));
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("falls back to cargo install when the release carries no asset for this target", async () => {
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([
          { name: `stellar-canary-${RESOLVED.version}-x86_64-unknown-freebsd.tar.gz`, url: DOWNLOAD_URL },
          { name: "SHA256SUMS", url: MANIFEST_URL },
        ]),
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.version).toBe("0.1.0");
      expect(coreMocks.debugMock).toHaveBeenCalledWith(
        expect.stringContaining("no prebuilt stellar-canary asset for target x86_64-unknown-linux-gnu"),
      );
      expect(spawnMock).toHaveBeenCalled();
    });

    it("falls back to cargo install when the prebuilt asset has no published checksum manifest", async () => {
      servePrebuiltRelease({
        releaseBody: releaseBodyWith([{ name: LINUX_X64_ASSET, url: DOWNLOAD_URL }]),
      });

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.version).toBe("0.1.0");
      expect(coreMocks.warningMock).toHaveBeenCalledWith(
        expect.stringContaining("no published checksum manifest"),
      );
      expect(spawnMock).toHaveBeenCalled();
    });

    it("falls back to cargo install when the prebuilt binary reports the wrong version", async () => {
      const archiveBytes = Buffer.from("wrong-version-payload");
      versionProbeResults = ["0.0.9"];
      mockExecWithFakeTar(flatExtract);
      servePrebuiltRelease(
        {
          releaseBody: releaseBodyWith([
            { name: LINUX_X64_ASSET, url: DOWNLOAD_URL },
            { name: "SHA256SUMS", url: MANIFEST_URL },
          ]),
          manifestBody: `${crypto.createHash("sha256").update(archiveBytes).digest("hex")}  ${LINUX_X64_ASSET}\n`,
          archiveBytes,
        },
        true,
      );

      const installed = await withPlatform("linux", () => withArch("x64", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.binaryPath).toBe(path.join(tempCargoHome, "bin", "stellar-canary"));
      expect(coreMocks.warningMock).toHaveBeenCalledWith(expect.stringContaining("reports version 0.0.9"));
      expect(spawnMock).toHaveBeenCalled();
    });

    it("skips the prebuilt path on an unsupported arch with a clear log and still installs from source", async () => {
      const installed = await withPlatform("linux", () => withArch("arm", () => ensureCanaryInstalled(RESOLVED)));

      expect(installed.version).toBe("0.1.0");
      expect(coreMocks.debugMock).toHaveBeenCalledWith(expect.stringContaining("Unsupported platform linux-arm"));
      expect(spawnMock).toHaveBeenCalled();
    });
  });
});
