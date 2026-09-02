import { afterEach, describe, expect, it, vi } from "vitest";

const { uploadArtifactMock } = vi.hoisted(() => ({ uploadArtifactMock: vi.fn() }));

vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    uploadArtifact = uploadArtifactMock;
  },
}));

import { ARTIFACT_NAME, uploadReport } from "../../src/artifact";

afterEach(() => {
  uploadArtifactMock.mockReset();
});

describe("uploadReport", () => {
  it("reports success and uses the fixed artifact name", async () => {
    uploadArtifactMock.mockResolvedValue({ id: 1, size: 100 });
    const outcome = await uploadReport("/tmp/stellar-canary-report.json");
    expect(outcome).toEqual({ uploaded: true });
    expect(uploadArtifactMock).toHaveBeenCalledWith(
      ARTIFACT_NAME,
      ["/tmp/stellar-canary-report.json"],
      "/tmp",
    );
  });

  it("never throws when the upload fails, and reports the reason", async () => {
    uploadArtifactMock.mockRejectedValue(new Error("service unavailable"));
    const outcome = await uploadReport("/tmp/stellar-canary-report.json");
    expect(outcome.uploaded).toBe(false);
    expect(outcome.reason).toContain("service unavailable");
  });
});
