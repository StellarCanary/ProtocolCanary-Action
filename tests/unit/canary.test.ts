import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import type * as osModule from "node:os";
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
}));

vi.mock("@actions/exec", () => ({
  exec: execMock,
}));

vi.mock("node:https", () => ({
  get: httpsGetMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>();
  return { ...actual, homedir: osMocks.homedirMock };
});

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
  destroy(): void {
    /* no-op for this fake */
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

  it("verifies an installed binary against its published checksum", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    mockPublishedChecksums(`${sha256(binaryPath())}  stellar-canary\n`);

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
  });

  it("throws InstallationFailedError when the installed binary does not match the published checksum", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    mockPublishedChecksums(`${"0".repeat(64)}  stellar-canary\n`);

    await expect(ensureCanaryInstalled(RESOLVED)).rejects.toThrow(InstallationFailedError);
  });

  it("falls back to commit/tag pinning when no checksum manifest is published", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    // beforeEach's default mock returns 404 for every request, i.e. the
    // release carries no checksum asset — the current upstream reality.

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.binaryPath).toBe(binaryPath());
    expect(installCalls()).toHaveLength(0);
  });

  // #275: parseChecksumManifest documents tolerance for the standard
  // sha256sum output format — `#` comment lines and the `*` binary-mode
  // marker before the file name — but nothing exercised either. Pinned
  // through the observable outcome: a manifest mixing comments and a
  // *-prefixed binary-mode entry must yield exactly that entry, and its
  // digest must be the one verification enforces.
  describe("#275 comments and binary-mode markers", () => {
    it("verifies against a manifest with comment lines and a *-prefixed binary-mode entry", async () => {
      fs.writeFileSync(binaryPath(), "binary");
      // Exactly what real publishing tools emit: a header comment, the
      // GNU coreutils binary-mode form `digest *filename`, and a trailing
      // blank line.
      mockPublishedChecksums(
        `# SHA256 checksums for Protocol-Canary 0.1.0\n` +
          `${sha256(binaryPath())} *${platformBinaryName()}\n` +
          `\n`,
      );

      const installed = await ensureCanaryInstalled(RESOLVED);

      // Parsing succeeded (the *-entry was found and matched, so no
      // "no usable entry" fallback) and the digest is enforced: the
      // matching binary verifies instead of failing or being skipped.
      expect(installed).toEqual({ binaryPath: binaryPath(), version: "0.1.0" });
    });

    it("rejects a tampered binary when only a *-prefixed binary-mode entry is published", async () => {
      fs.writeFileSync(binaryPath(), "not-the-published-binary");
      mockPublishedChecksums(
        `# generated by release tooling\n${"d".repeat(64)} *${platformBinaryName()}\n`,
      );

      // The quoted digest from the binary-mode line proves the entry was
      // parsed from that line (and not from some fallback), so a parser
      // regression that silently dropped *-entries would fail here.
      const error = await ensureCanaryInstalled(RESOLVED).then(
        () => {
          throw new Error("expected ensureCanaryInstalled to reject");
        },
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(InstallationFailedError);
      expect((error as InstallationFailedError).message).toContain("d".repeat(64));
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
});
