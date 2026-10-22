/**
 * Negative integrity tests (issue #375) and the fail-closed behaviour of the
 * optional strict-integrity policy (issue #372) at the engine-installation
 * boundary.
 *
 * Scope note, kept honest to what this Action actually is: there is no
 * fixture-pack `DownloadManager` on `main` yet — that pipeline is issue #338,
 * still unmerged — so the "spoofed redirect" and "tampered artifact" security
 * boundaries these tests pin are the ones the Action really enforces today:
 * the published-checksum verification chain in `src/canary.ts`
 * (`ensureCanaryInstalled` → `verifyInstalledBinary` → `httpsGetText`).
 * Accordingly these tests assert the repo's real error taxonomy
 * ({@link InstallationFailedError}, `code: "InstallationFailed"`), not the
 * `SecurityPolicyError` the issue drafted against the unbuilt downloader.
 *
 * The mocking scaffold mirrors `canary.test.ts` deliberately (same module
 * mocks, same fake-HTTP machinery) so every request is offline and the suite
 * is deterministic on all three CI platforms.
 */
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
}));

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
const httpsGetMock = vi.hoisted(() => vi.fn());
const osMocks = vi.hoisted(() => ({ homedirMock: vi.fn() }));

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

import { ensureCanaryInstalled } from "../../src/canary";
import type { ResolvedVersion } from "../../src/version";

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
function respond(statusCode: number, body: string, headers: Record<string, string> = {}): any {
  return (_url: string, _options: unknown, callback: (response: FakeResponse) => void) => {
    const response = new FakeResponse(statusCode);
    response.headers = headers;
    const request = new FakeRequest();
    callback(response);
    queueMicrotask(() => {
      response.emit("data", body);
      response.emit("end");
    });
    return request;
  };
}

/**
 * Fake transport that behaves like Node's `https.get` about schemes: a
 * plain `http://` target can never complete a TLS handshake, so the request
 * errors out. Used to prove the Action unconditionally rejects unencrypted
 * manifest/redirect targets (issue #375 "Negative testing").
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function httpsOnlyTransport(): any {
  return (url: string, _options: unknown, callback: (response: FakeResponse) => void) => {
    if (url.startsWith("http://")) {
      const request = new FakeRequest();
      queueMicrotask(() => request.emit("error", new Error(`ERR_INVALID_SCHEME: ${url}`)));
      return request;
    }
    return respond(404, "")(url, _options, callback);
  };
}

/** Release JSON whose only checksum asset points at the given URL. */
function releaseWithAsset(assetUrl: string): string {
  return JSON.stringify({
    assets: [{ name: "SHA256SUMS", browser_download_url: assetUrl }],
  });
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** All URLs the Action actually requested, in order. */
function requestedUrls(): string[] {
  return httpsGetMock.mock.calls.map((call) => String(call[0]));
}

describe("tamper detection and spoofed redirects (issue #375)", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;

  function binaryPath(): string {
    return path.join(tempCargoHome, "bin", process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary");
  }

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-integrity-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    process.env.CARGO_HOME = tempCargoHome;

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(true);
    cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
    cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
    osMocks.homedirMock.mockReset().mockReturnValue(path.join(os.tmpdir(), "canary-integrity-not-the-real-home"));
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();

    execMock.mockReset();
    execMock.mockImplementation(
      async (command: string, args: string[] = [], options: { listeners?: { stdout?: (d: Buffer) => void } } = {}): Promise<number> => {
        if (command === "cargo" && args[0] === "--version") {
          return 0;
        }
        options.listeners?.stdout?.(Buffer.from("stellar-canary 0.1.0\n"));
        return 0;
      },
    );

    spawnMock.mockReset();
    spawnMock.mockImplementation(() => new ImmediateChild(0) as unknown as ChildProcess);

    httpsGetMock.mockReset();
    httpsGetMock.mockImplementation(respond(404, ""));
  });

  afterEach(() => {
    if (originalCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = originalCargoHome;
    }
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  // #424: a source build is never compared against a published release
  // checksum, so a manifest mismatch, a spoofed redirect, an unencrypted
  // manifest target, or a malformed manifest can no longer affect a source
  // install — none of them is even looked up. The release-asset path performs
  // the real comparison (see the prebuilt suite in canary.test.ts). These
  // tests pin the source-build boundary: make no lookup, never fail on a
  // checksum, and anchor integrity on the commit/tag pin.
  it("never compares a source build against a published checksum, even a one-byte tamper (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binarey");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(200, `${sha256("binary")}  stellar-canary\n`));

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.origin).toBe("source-build");
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(coreMocks.infoMock).toHaveBeenCalledWith(
      expect.stringContaining("release checksums do not apply to source builds"),
    );
  });

  it("never looks up a manifest for a source build, so a truncated binary is not checksum-rejected (#424)", async () => {
    const full = "full-canary-payload";
    httpsGetMock
      .mockImplementationOnce(respond(404, ""))
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(200, `${sha256(full)}  stellar-canary\n`));

    spawnMock.mockImplementation(() => {
      fs.writeFileSync(binaryPath(), full.slice(0, 5));
      return new ImmediateChild(0) as unknown as ChildProcess;
    });

    const installed = await ensureCanaryInstalled(RESOLVED);

    expect(installed.origin).toBe("source-build");
    // The only HTTP request is the prebuilt release-asset probe (which 404s);
    // no checksum manifest is ever fetched for a source build.
    expect(requestedUrls().some((url) => url.includes("SHA256SUMS"))).toBe(false);
    expect(coreMocks.infoMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Verified stellar-canary"),
    );
  });

  it("never issues a request for a source build, so no redirect target can be followed (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(302, "", { location: "https://evil.example.com/SHA256SUMS" }));

    const installed = await ensureCanaryInstalled(RESOLVED);
    expect(installed.origin).toBe("source-build");

    // The D-11 boundary: no request is ever issued, so nothing can be
    // redirected anywhere.
    expect(requestedUrls()).toHaveLength(0);
  });

  it("does not trust or even fetch an http:// manifest for a source build (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock.mockReset().mockImplementation(httpsOnlyTransport());
    httpsGetMock.mockImplementationOnce(
      respond(200, releaseWithAsset("http://example.test/SHA256SUMS")),
    );

    const installed = await ensureCanaryInstalled(RESOLVED);
    expect(installed.origin).toBe("source-build");
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(coreMocks.infoMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Verified stellar-canary"),
    );
  });

  it("does not parse a malformed checksum manifest for a source build (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(200, "not-a-digest-at-all  stellar-canary\n"));

    const installed = await ensureCanaryInstalled(RESOLVED);
    expect(installed.origin).toBe("source-build");
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(coreMocks.infoMock).not.toHaveBeenCalledWith(expect.stringContaining("Verified stellar-canary"));
  });
});

describe("strict-integrity fail-closed policy at the verification boundary (issue #372)", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;

  function binaryPath(): string {
    return path.join(tempCargoHome, "bin", process.platform === "win32" ? "stellar-canary.exe" : "stellar-canary");
  }

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-strict-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    process.env.CARGO_HOME = tempCargoHome;

    cacheMocks.isFeatureAvailableMock.mockReset().mockReturnValue(false);
    cacheMocks.restoreCacheMock.mockReset().mockResolvedValue(undefined);
    cacheMocks.saveCacheMock.mockReset().mockResolvedValue(undefined);
    osMocks.homedirMock.mockReset().mockReturnValue(path.join(os.tmpdir(), "canary-strict-not-the-real-home"));
    coreMocks.infoMock.mockReset();
    coreMocks.debugMock.mockReset();
    coreMocks.warningMock.mockReset();

    execMock.mockReset();
    execMock.mockImplementation(
      async (command: string, args: string[] = [], options: { listeners?: { stdout?: (d: Buffer) => void } } = {}): Promise<number> => {
        if (command === "cargo" && args[0] === "--version") {
          return 0;
        }
        options.listeners?.stdout?.(Buffer.from("stellar-canary 0.1.0\n"));
        return 0;
      },
    );

    spawnMock.mockReset();
    spawnMock.mockImplementation(() => new ImmediateChild(0) as unknown as ChildProcess);

    httpsGetMock.mockReset();
    httpsGetMock.mockImplementation(respond(404, ""));
  });

  afterEach(() => {
    if (originalCargoHome === undefined) {
      delete process.env.CARGO_HOME;
    } else {
      process.env.CARGO_HOME = originalCargoHome;
    }
    fs.rmSync(tempCargoHome, { recursive: true, force: true });
  });

  // #424: under strict-integrity a source build fails closed immediately,
  // because its integrity cannot be proven against a published release
  // checksum (release checksums apply only to downloaded release assets).
  // No manifest lookup is performed first.
  it("fails closed for a source build because integrity cannot be proven (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");

    await expect(ensureCanaryInstalled(RESOLVED, 60_000, undefined, true)).rejects.toThrow(
      /strict-integrity.*built from source/s,
    );
    expect(httpsGetMock).not.toHaveBeenCalled();
  });

  it("fails closed before any manifest lookup even when a manifest is published (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(200, `${"a".repeat(64)}  some-other-tool\n`));

    await expect(ensureCanaryInstalled(RESOLVED, 60_000, undefined, true)).rejects.toThrow(/strict-integrity/s);
    expect(httpsGetMock).not.toHaveBeenCalled();
  });

  it("never consults a redirect target under strict-integrity (#424)", async () => {
    fs.writeFileSync(binaryPath(), "binary");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(302, "", { location: "https://evil.example.com/SHA256SUMS" }));

    await expect(ensureCanaryInstalled(RESOLVED, 60_000, undefined, true)).rejects.toThrow(/strict-integrity/s);
    const urls = requestedUrls();
    expect(urls.some((url) => url.includes("evil.example.com"))).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it("fails closed and never persists the binary to cache under strict-integrity (#424)", async () => {
    cacheMocks.isFeatureAvailableMock.mockReturnValue(true);
    fs.writeFileSync(binaryPath(), "tampered");
    httpsGetMock
      .mockImplementationOnce(respond(200, releaseWithAsset("https://example.test/SHA256SUMS")))
      .mockImplementationOnce(respond(200, `${sha256("pristine")}  stellar-canary\n`));

    await expect(ensureCanaryInstalled(RESOLVED, 60_000, undefined, true)).rejects.toThrow(/strict-integrity/s);
    expect(cacheMocks.saveCacheMock).not.toHaveBeenCalled();
  });

  it("preserves default (non-strict) behaviour: a source build is not compared, just pinned", async () => {
    fs.writeFileSync(binaryPath(), "binary");

    const installed = await ensureCanaryInstalled(RESOLVED);
    expect(installed.binaryPath).toBe(binaryPath());
    expect(installed.origin).toBe("source-build");
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(coreMocks.infoMock).toHaveBeenCalledWith(
      expect.stringContaining("release checksums do not apply to source builds"),
    );
  });
});
