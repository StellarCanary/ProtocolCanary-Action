import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigNotFoundError, InvalidInputError } from "../../src/errors";
import { getInputs } from "../../src/inputs";

const INPUT_KEYS = [
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_NETWORK",
  "INPUT_RPC-URL",
  "INPUT_FIXTURES-DIR",
  "INPUT_VERSION",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_TIMEOUT-MINUTES",
];

function clearInputs(): void {
  for (const key of INPUT_KEYS) {
    delete process.env[key];
  }
}

describe("getInputs", () => {
  beforeEach(clearInputs);
  afterEach(clearInputs);

  it("applies documented defaults when nothing is set", () => {
    const inputs = getInputs();
    expect(inputs).toEqual({
      protocol: undefined,
      config: undefined,
      network: undefined,
      rpcUrl: undefined,
      fixturesDir: "fixtures",
      version: "0.1.1",
      uploadReport: true,
      annotations: true,
      timeoutMinutes: 15,
    });
  });

  it("parses a valid protocol", () => {
    process.env.INPUT_PROTOCOL = "28";
    expect(getInputs().protocol).toBe(28);
  });

  it("accepts protocol '0' as a valid non-negative integer", () => {
    process.env.INPUT_PROTOCOL = "0";
    expect(getInputs().protocol).toBe(0);
  });

  it("rejects a non-numeric protocol", () => {
    process.env.INPUT_PROTOCOL = "not-a-number";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("rejects a config path that does not exist", () => {
    process.env.INPUT_CONFIG = "/nonexistent/.stellar-canary.toml";
    expect(() => getInputs()).toThrow(ConfigNotFoundError);
  });

  it("returns a config path resolved to an absolute path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-config-"));
    const configPath = path.join(dir, ".stellar-canary.toml");
    fs.writeFileSync(configPath, "[tests]\n", "utf8");
    try {
      // Deliberately relative: this is what distinguishes the resolved value
      // from the raw input that used to be returned.
      const relative = path.relative(process.cwd(), configPath);
      process.env.INPUT_CONFIG = relative;

      const inputs = getInputs();

      // The value forwarded to the CLI as --config must be exactly the path
      // the existence check validated, not the string as written.
      expect(inputs.config).toBe(configPath);
      expect(inputs.config).not.toBe(relative);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a config path that exists but is a directory", () => {
    // parseConfig validates with fs.existsSync, which is true for a directory
    // just as much as for a file, so it does not reject this here. This test
    // pins the current (permissive) behavior: a directory is accepted and
    // only fails later inside the stellar-canary CLI, with a less specific
    // error than ConfigNotFoundError would give up front.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-config-dir-"));
    try {
      process.env.INPUT_CONFIG = dir;
      expect(getInputs().config).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an https rpc-url", () => {
    process.env["INPUT_RPC-URL"] = "https://soroban-testnet.stellar.org";
    expect(getInputs().rpcUrl).toBe("https://soroban-testnet.stellar.org");
  });

  it("accepts http for localhost only", () => {
    process.env["INPUT_RPC-URL"] = "http://localhost:8000/soroban/rpc";
    expect(getInputs().rpcUrl).toBe("http://localhost:8000/soroban/rpc");
  });

  it("rejects plain http for a non-local host", () => {
    process.env["INPUT_RPC-URL"] = "http://example.com/rpc";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("rejects a malformed rpc-url", () => {
    process.env["INPUT_RPC-URL"] = "not a url";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("normalizes a version with a leading v", () => {
    process.env.INPUT_VERSION = "v0.1.0";
    expect(getInputs().version).toBe("0.1.0");
  });

  it("rejects a non-semver version", () => {
    process.env.INPUT_VERSION = "latest";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it.each(["true", "True", "TRUE"])("accepts %s as a true boolean", (value) => {
    process.env["INPUT_UPLOAD-REPORT"] = value;
    expect(getInputs().uploadReport).toBe(true);
  });

  it.each(["false", "False", "FALSE"])("accepts %s as a false boolean", (value) => {
    process.env["INPUT_UPLOAD-REPORT"] = value;
    expect(getInputs().uploadReport).toBe(false);
  });

  it("rejects an undocumented boolean form", () => {
    process.env["INPUT_UPLOAD-REPORT"] = "yes";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("rejects a zero or negative timeout", () => {
    process.env["INPUT_TIMEOUT-MINUTES"] = "0";
    expect(() => getInputs()).toThrow(InvalidInputError);
  });

  it("parses a valid timeout", () => {
    process.env["INPUT_TIMEOUT-MINUTES"] = "30";
    expect(getInputs().timeoutMinutes).toBe(30);
  });
});
