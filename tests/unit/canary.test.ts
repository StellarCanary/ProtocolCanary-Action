import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureCanaryInstalled } from "../../src/canary";
import { InstallationFailedError } from "../../src/errors";
import { ResolvedVersion } from "../../src/version";

const { isFeatureAvailableMock, restoreCacheMock, httpsGetMock } = vi.hoisted(() => ({
  isFeatureAvailableMock: vi.fn(),
  restoreCacheMock: vi.fn(),
  httpsGetMock: vi.fn(),
}));

// The cache client is stubbed out so no test in this file can reach the
// GitHub cache service: restoreFromCache/saveToCache become inert no-ops.
// This keeps every code path (including the cargo-unavailable one) offline
// and deterministic even on GitHub-hosted runners, where the Actions cache
// feature would otherwise be available.
vi.mock("@actions/cache", () => ({
  isFeatureAvailable: isFeatureAvailableMock,
  restoreCache: restoreCacheMock,
  saveCache: vi.fn(),
}));

// The GitHub REST calls made while looking up a published checksum are
// stubbed too: no test in this file may hit the network.
vi.mock("node:https", () => ({
  get: httpsGetMock,
}));

const MOCK_CANARY_SOURCE = path.join(__dirname, "..", "fixtures", "mock-canary.cjs");

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

  function installMockBinary(): string {
    const binaryPath = path.join(tempCargoHome, "bin", "stellar-canary");
    fs.copyFileSync(MOCK_CANARY_SOURCE, binaryPath);
    fs.chmodSync(binaryPath, 0o755);
    return binaryPath;
  }

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-cargo-home-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    process.env.CARGO_HOME = tempCargoHome;
    process.env.MOCK_CANARY_VERSION = "0.1.0";
    isFeatureAvailableMock.mockReturnValue(false);
    restoreCacheMock.mockClear();
    // No checksum release by default: every lookup degrades gracefully.
    httpsGetMock.mockReset();
    httpsGetMock.mockImplementation(respond(404, ""));
  });

  afterEach(() => {
    if (originalCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = originalCargoHome;
    }
    delete process.env.MOCK_CANARY_VERSION;
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  it("uses an already-installed binary when its version matches, without installing anything", async () => {
    const binaryPath = installMockBinary();

    const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
    const installed = await ensureCanaryInstalled(resolved);

    expect(installed.binaryPath).toBe(binaryPath);
    expect(installed.version).toBe("0.1.0");
  });

  it("does not reuse an already-installed binary with a different version", async () => {
    installMockBinary();
    process.env.MOCK_CANARY_VERSION = "0.0.9";

    // A version mismatch falls through to cache-then-cargo-install, which
    // this offline test cannot complete — asserting the rejection is
    // enough to prove the stale binary was correctly rejected rather than
    // silently reused.
    const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
    await expect(ensureCanaryInstalled(resolved)).rejects.toThrow();
  }, 30_000);

  it("rejects with InstallationFailedError when cargo is unavailable", async () => {
    // Simulate a runner with no Rust toolchain: CARGO_HOME already points
    // at the empty temp dir from beforeEach, PATH is scrubbed of every
    // directory that could resolve a `cargo` binary, and the cache client
    // is stubbed off (see the vi.mock above) so restoreFromCache can neither
    // reach the cache service nor short-circuit with a hit, even on
    // GitHub-hosted runners. `@actions/exec` looks up the command with
    // `io.which(..., true)`, so the very first `cargo --version` probe
    // rejects before any network call is attempted.
    const originalPath = process.env.PATH;
    const originalPathExt = process.env.PATHEXT;
    process.env.PATH = tempCargoHome;
    delete process.env.PATHEXT;

    try {
      const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
      try {
        await ensureCanaryInstalled(resolved);
        expect.unreachable("ensureCanaryInstalled should have rejected when cargo is unavailable");
      } catch (error) {
        expect(error).toBeInstanceOf(InstallationFailedError);
        expect((error as InstallationFailedError).code).toBe("InstallationFailed");

        // The whole point of this error message is to tell a self-hosted
        // or non-Ubuntu runner operator exactly what to install.
        const message = (error as InstallationFailedError).message;
        expect(message).toContain("The `cargo` command was not found on this runner");
        expect(message).toContain("dtolnay/rust-toolchain");
      }

      // Guard the offline guarantee: with the cache client stubbed out, the
      // cache path must never run, let alone short-circuit this failure.
      expect(restoreCacheMock).not.toHaveBeenCalled();
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathExt === undefined) {
        delete process.env.PATHEXT;
      } else {
        process.env.PATHEXT = originalPathExt;
      }
    }
  });

  it("verifies an installed binary against its published checksum", async () => {
    const binaryPath = installMockBinary();
    mockPublishedChecksums(`${sha256(binaryPath)}  stellar-canary\n`);

    const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
    const installed = await ensureCanaryInstalled(resolved);

    expect(installed.binaryPath).toBe(binaryPath);
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
  });

  it("throws InstallationFailedError when the installed binary does not match the published checksum", async () => {
    installMockBinary();
    mockPublishedChecksums(`${"0".repeat(64)}  stellar-canary\n`);

    const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
    await expect(ensureCanaryInstalled(resolved)).rejects.toThrow(InstallationFailedError);
  });

  it("falls back to commit/tag pinning when no checksum manifest is published", async () => {
    const binaryPath = installMockBinary();
    // beforeEach's default mock returns 404 for every request, i.e. the
    // release carries no checksum asset — the current upstream reality.

    const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
    const installed = await ensureCanaryInstalled(resolved);

    expect(installed.binaryPath).toBe(binaryPath);
  });
});
