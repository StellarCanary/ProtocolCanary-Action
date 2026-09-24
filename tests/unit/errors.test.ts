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

  it("keeps Error handling ahead of JSON serialization", () => {
    // Even when an Error carries enumerable extra properties, the
    // documented behavior is to surface only its message.
    const error = new Error("boom") as Error & { code?: string };
    error.code = "E_TEST";
    expect(describeError(error)).toBe("boom");
  });

  it("stringifies a non-Error value", () => {
    expect(describeError("plain string")).toBe("plain string");
  });

  it("serializes a thrown plain object instead of [object Object]", () => {
    // Third-party dependencies sometimes reject with bare objects. The
    // fallback branch must produce a useful representation of their
    // contents rather than JavaScript's default `[object Object]`.
    expect(describeError({ code: "E_TEST", detail: "something went wrong" })).toBe(
      '{"code":"E_TEST","detail":"something went wrong"}'
    );
    expect(describeError({ code: "E_TEST", detail: "something went wrong" })).not.toBe(
      "[object Object]"
    );
  });

  it("serializes a thrown array", () => {
    // Arrays are objects too, so they take the same JSON path and are
    // described by their contents.
    expect(describeError(["E_TEST", 500])).toBe('["E_TEST",500]');
  });

  it("falls back to String when JSON serialization fails", () => {
    // Circular references make JSON.stringify throw; describeError must
    // degrade to String(error) instead of propagating the TypeError.
    const circular: { code?: string; self?: unknown } = { code: "E_TEST" };
    circular.self = circular;
    expect(describeError(circular)).toBe(String(circular));
  });

  it("falls back to String when JSON serialization yields no usable output", () => {
    // An object whose toJSON returns undefined makes JSON.stringify return
    // undefined, which is unusable as a message.
    expect(describeError({ toJSON: () => undefined })).toBe(
      String({ toJSON: () => undefined })
    );
  });

  it("stringifies a thrown number as its decimal literal", () => {
    // Locks down that numeric thrown values (e.g. C-style error codes)
    // survive the fallback branch unchanged rather than being wrapped in
    // additional text.
    expect(describeError(42)).toBe("42");
  });
});
