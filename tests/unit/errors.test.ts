import { describe, expect, it } from "vitest";

import {
  ConfigNotFoundError,
  TimeoutError,
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

  it("sets the TimeoutError code", () => {
    expect(new TimeoutError("boom").code).toBe("Timeout");
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

  it("stringifies a thrown plain object as [object Object]", () => {
    // Third-party dependencies sometimes reject with bare objects. The
    // fallback branch reduces such values to JavaScript's default object
    // stringification, which is unhelpful but must not throw or crash.
    expect(describeError({ code: 500, details: "boom" })).toBe("[object Object]");
  });

  it("stringifies a thrown number as its decimal literal", () => {
    // Locks down that numeric thrown values (e.g. C-style error codes)
    // survive the fallback branch unchanged rather than being wrapped in
    // additional text.
    expect(describeError(42)).toBe("42");
  });
});
