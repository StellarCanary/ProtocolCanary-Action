import type * as actionsCore from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { errorMock, warningMock } = vi.hoisted(() => ({
  errorMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof actionsCore>();
  return { ...actual, error: errorMock, warning: warningMock };
});

import type { AnnotationProperties } from "@actions/core";
import { emitAnnotations, emitExecutionFailureAnnotation } from "../../src/annotations";
import { report, result } from "./helpers";

afterEach(() => {
  errorMock.mockReset();
  warningMock.mockReset();
});

describe("emitAnnotations", () => {
  it("emits an error annotation for a fail result", () => {
    emitAnnotations(report([result({ status: "fail", testId: "p28-xdr-1", summary: "decode failed" })]));
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0]?.[0]).toContain("p28-xdr-1");
    expect(errorMock.mock.calls[0]?.[1]).toMatchObject({ title: "Stellar Protocol Canary" });
  });

  it("emits an error annotation for an error result", () => {
    emitAnnotations(report([result({ status: "error", testId: "p28-rpc-1" })]));
    expect(errorMock).toHaveBeenCalledTimes(1);
  });

  it("emits a warning annotation for a warning result", () => {
    emitAnnotations(report([result({ status: "warning", testId: "p28-rpc-2" })]));
    expect(warningMock).toHaveBeenCalledTimes(1);
  });

  it("never annotates a pass or skipped result", () => {
    emitAnnotations(report([result({ status: "pass" }), result({ status: "skipped" })]));
    expect(errorMock).not.toHaveBeenCalled();
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("never sets a file/line location, since fixtures do not carry one", () => {
    emitAnnotations(report([result({ status: "fail" })]));
    const properties = errorMock.mock.calls[0]?.[1] as AnnotationProperties | undefined;
    expect(properties?.file).toBeUndefined();
    expect(properties?.startLine).toBeUndefined();
  });
});

describe("emitExecutionFailureAnnotation", () => {
  it("emits a single general error annotation", () => {
    emitExecutionFailureAnnotation("cargo install failed");
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(errorMock.mock.calls[0]?.[0]).toContain("cargo install failed");
  });
});
