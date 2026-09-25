import { afterEach, describe, expect, it, vi } from "vitest";

const { uploadArtifactMock } = vi.hoisted(() => ({ uploadArtifactMock: vi.fn() }));

vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    uploadArtifact = uploadArtifactMock;
  },
}));

import { ARTIFACT_NAME, fallbackArtifactName, isArtifactNameCollision, uploadReport } from "../../src/artifact";

const REPORT_PATH = "/tmp/stellar-canary-report.json";
const REPORT_DIR = "/tmp";

/** The exact error `@actions/artifact` throws for a duplicate name. */
function conflictError(): Error {
  return new Error(
    "Received non-retryable error: Failed request: (409) Conflict: " +
      "an artifact with this name already exists on the workflow run",
  );
}

afterEach(() => {
  uploadArtifactMock.mockReset();
});

describe("uploadReport", () => {
  it("reports success and uses the fixed artifact name", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 1, size: 100 });
    const outcome = await uploadReport(REPORT_PATH);
    expect(outcome).toEqual({ uploaded: true });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
    expect(uploadArtifactMock).toHaveBeenCalledWith(ARTIFACT_NAME, [REPORT_PATH], REPORT_DIR);
  });

  it("keeps the stable name even when a differentiator is supplied but the name is free", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 1, size: 100 });
    const outcome = await uploadReport(REPORT_PATH, "protocol-28");
    expect(outcome).toEqual({ uploaded: true });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
    expect(uploadArtifactMock).toHaveBeenCalledWith(ARTIFACT_NAME, [REPORT_PATH], REPORT_DIR);
  });

  it("retries under a differentiator-derived name when the stable name already exists", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 100 });

    const outcome = await uploadReport(REPORT_PATH, "protocol-28-network-testnet");

    expect(outcome).toEqual({ uploaded: true });
    expect(uploadArtifactMock).toHaveBeenCalledTimes(2);
    expect(uploadArtifactMock).toHaveBeenNthCalledWith(1, ARTIFACT_NAME, [REPORT_PATH], REPORT_DIR);
    expect(uploadArtifactMock).toHaveBeenNthCalledWith(
      2,
      `${ARTIFACT_NAME}-protocol-28-network-testnet`,
      [REPORT_PATH],
      REPORT_DIR,
    );
  });

  it("produces distinct artifact names for two colliding invocations with different inputs", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 1, size: 1 })
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 2, size: 1 });

    await uploadReport(REPORT_PATH, "protocol-28-network-testnet");
    await uploadReport(REPORT_PATH, "protocol-28-network-mainnet");

    const names = uploadArtifactMock.mock.calls.map((call) => call[0] as string);
    expect(names).toEqual([
      ARTIFACT_NAME,
      `${ARTIFACT_NAME}-protocol-28-network-testnet`,
      ARTIFACT_NAME,
      `${ARTIFACT_NAME}-protocol-28-network-mainnet`,
    ]);
    expect(new Set(names).size).toBe(3);
  });

  it("falls back to a short unique name when no differentiator was given", async () => {
    uploadArtifactMock
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce({ id: 1, size: 1 });

    const outcome = await uploadReport(REPORT_PATH);

    expect(outcome).toEqual({ uploaded: true });
    const fallbackName = uploadArtifactMock.mock.calls[1]?.[0] as string;
    expect(fallbackName).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
    expect(fallbackName).not.toBe(ARTIFACT_NAME);
  });

  it("does not retry on a non-collision failure, and reports the reason", async () => {
    uploadArtifactMock.mockRejectedValue(new Error("service unavailable"));
    const outcome = await uploadReport(REPORT_PATH, "protocol-28");
    expect(outcome.uploaded).toBe(false);
    expect(outcome.reason).toContain("service unavailable");
    expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the fallback upload also fails", async () => {
    uploadArtifactMock.mockRejectedValue(conflictError());
    const outcome = await uploadReport(REPORT_PATH, "protocol-28");
    expect(outcome.uploaded).toBe(false);
    expect(uploadArtifactMock).toHaveBeenCalledTimes(2);
  });
});

describe("fallbackArtifactName", () => {
  it("sanitizes a differentiator into a valid artifact name", () => {
    expect(fallbackArtifactName("protocol-28 network: testnet")).toBe(
      `${ARTIFACT_NAME}-protocol-28-network-testnet`,
    );
  });

  it("generates unique names when no differentiator is available", () => {
    expect(fallbackArtifactName()).not.toBe(fallbackArtifactName());
  });
});

describe("isArtifactNameCollision", () => {
  it("recognizes the duplicate-name conflict and ignores unrelated failures", () => {
    expect(isArtifactNameCollision(conflictError())).toBe(true);
    expect(isArtifactNameCollision(new Error("service unavailable"))).toBe(false);
    expect(isArtifactNameCollision(new Error("File /tmp/report.json does not exist"))).toBe(false);
  });
});
