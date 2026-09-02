import { describe, expect, it } from "vitest";

import {
  ConfigNotFoundError,
  InvalidInputError,
  describeError,
  isCanaryActionError,
} from "../../src/errors";

describe("CanaryActionError hierarchy", () => {
  it("names each error after its class", () => {
    expect(new InvalidInputError("bad").name).toBe("InvalidInputError");
  });

  it("builds a clear message for a missing config file", () => {
    const error = new ConfigNotFoundError(".stellar-canary.toml");
    expect(error.message).toBe("Configuration file not found: .stellar-canary.toml");
    expect(error.code).toBe("ConfigNotFound");
  });

  it("isCanaryActionError distinguishes typed errors from arbitrary errors", () => {
    expect(isCanaryActionError(new InvalidInputError("x"))).toBe(true);
    expect(isCanaryActionError(new Error("plain"))).toBe(false);
    expect(isCanaryActionError("not an error")).toBe(false);
  });
});

describe("describeError", () => {
  it("returns the message of an Error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(describeError("plain string")).toBe("plain string");
  });
});
