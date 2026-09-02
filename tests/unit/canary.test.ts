import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureCanaryInstalled } from "../../src/canary";
import { ResolvedVersion } from "../../src/version";

const MOCK_CANARY_SOURCE = path.join(__dirname, "..", "fixtures", "mock-canary.cjs");

describe("ensureCanaryInstalled", () => {
  let tempCargoHome: string;
  let originalCargoHome: string | undefined;

  beforeEach(() => {
    tempCargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "canary-cargo-home-"));
    fs.mkdirSync(path.join(tempCargoHome, "bin"), { recursive: true });
    originalCargoHome = process.env.CARGO_HOME;
    process.env.CARGO_HOME = tempCargoHome;
    process.env.MOCK_CANARY_VERSION = "0.1.0";
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
    const binaryPath = path.join(tempCargoHome, "bin", "stellar-canary");
    fs.copyFileSync(MOCK_CANARY_SOURCE, binaryPath);
    fs.chmodSync(binaryPath, 0o755);

    const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
    const installed = await ensureCanaryInstalled(resolved);

    expect(installed.binaryPath).toBe(binaryPath);
    expect(installed.version).toBe("0.1.0");
  });

  it("does not reuse an already-installed binary with a different version", async () => {
    const binaryPath = path.join(tempCargoHome, "bin", "stellar-canary");
    fs.copyFileSync(MOCK_CANARY_SOURCE, binaryPath);
    fs.chmodSync(binaryPath, 0o755);
    process.env.MOCK_CANARY_VERSION = "0.0.9";

    // A version mismatch falls through to cache-then-cargo-install, which
    // this offline test cannot complete — asserting the rejection is
    // enough to prove the stale binary was correctly rejected rather than
    // silently reused.
    const resolved: ResolvedVersion = { version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" };
    await expect(ensureCanaryInstalled(resolved)).rejects.toThrow();
  }, 30_000);
});
