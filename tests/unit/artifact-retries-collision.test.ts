import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadArtifactMock, infoMock, warningMock } = vi.hoisted(() => ({
  uploadArtifactMock: vi.fn(),
  infoMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("@actions/artifact", () => ({
  DefaultArtifactClient: class {
    uploadArtifact = uploadArtifactMock;
  },
}));

vi.mock("@actions/core", () => ({
  info: infoMock,
  warning: warningMock,
}));

import {
  ARTIFACT_NAME,
  MAX_REPORT_UPLOAD_ATTEMPTS,
  RECEIPT_ARTIFACT_PREFIX,
  fallbackArtifactName,
  isArtifactNameCollision,
  receiptArtifactName,
  uploadReceipt,
  uploadReport,
} from "../../src/artifact";

const REPORT_PATH = "/tmp/canary-run/stellar-canary-report.json";
const REPORT_DIR = "/tmp/canary-run";
const RECEIPT_PATH = "/tmp/canary-run/stellar-canary-receipt.json";

function makeConflictError(detail = "an artifact with this name already exists on the workflow run"): Error {
  return new Error(`Received non-retryable error: Failed request: (409) Conflict: ${detail}`);
}

describe("artifact upload retry policy and collision fallback resolution (#749)", () => {
  const originalRunId = process.env.GITHUB_RUN_ID;

  beforeEach(() => {
    delete process.env.GITHUB_RUN_ID;
  });

  afterEach(() => {
    uploadArtifactMock.mockReset();
    infoMock.mockReset();
    warningMock.mockReset();
    if (originalRunId === undefined) {
      delete process.env.GITHUB_RUN_ID;
    } else {
      process.env.GITHUB_RUN_ID = originalRunId;
    }
  });

  describe("isArtifactNameCollision", () => {
    it("detects HTTP 409, Conflict messages, and artifact already-exists errors", () => {
      expect(isArtifactNameCollision(makeConflictError())).toBe(true);
      expect(isArtifactNameCollision(new Error("Failed request: (409) duplicate name"))).toBe(true);
      expect(isArtifactNameCollision(new Error("Upload conflict detected by backend"))).toBe(true);
      expect(isArtifactNameCollision(new Error("The artifact stellar-canary already exists"))).toBe(true);
      expect(isArtifactNameCollision("conflict: duplicate artifact")).toBe(true);
    });

    it("rejects non-collision network and storage errors", () => {
      expect(isArtifactNameCollision(new Error("connect ETIMEDOUT 140.82.112.5:443"))).toBe(false);
      expect(isArtifactNameCollision(new Error("Failed request: (503) Service Unavailable"))).toBe(false);
      expect(isArtifactNameCollision(new Error("Directory already exists on disk"))).toBe(false);
      expect(isArtifactNameCollision("socket hang up")).toBe(false);
    });
  });

  describe("fallbackArtifactName", () => {
    it("appends sanitized differentiator when a valid non-empty differentiator is provided", () => {
      expect(fallbackArtifactName("protocol-28")).toBe(`${ARTIFACT_NAME}-protocol-28`);
      expect(fallbackArtifactName("  testnet / protocol:28!  ")).toBe(
        `${ARTIFACT_NAME}-testnet-protocol-28`,
      );
      expect(fallbackArtifactName("---v1.2_rc1---")).toBe(`${ARTIFACT_NAME}-v1.2_rc1`);
    });

    it("generates unique non-colliding fallback names when differentiator is omitted or sanitizes to empty", () => {
      const generated = new Set<string>();
      for (const raw of [undefined, "", "   ", "///:::***", "---"]) {
        const candidate = fallbackArtifactName(raw);
        expect(candidate).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
        expect(candidate).not.toBe(ARTIFACT_NAME);
        generated.add(candidate);
      }
      expect(generated.size).toBeGreaterThanOrEqual(4);
    });
  });

  describe("receiptArtifactName", () => {
    it("formats run ID prefixes cleanly and sanitizes non-artifact characters", () => {
      expect(receiptArtifactName("987654321")).toBe(`${RECEIPT_ARTIFACT_PREFIX}-987654321`);
      expect(receiptArtifactName("  run/42:attempt#2  ")).toBe(
        `${RECEIPT_ARTIFACT_PREFIX}-run-42-attempt-2`,
      );
      expect(receiptArtifactName("run_2026.11")).toBe(`${RECEIPT_ARTIFACT_PREFIX}-run_2026.11`);
    });

    it("generates a unique run-scoped fallback suffix when run ID is undefined or blank", () => {
      const first = receiptArtifactName(undefined);
      const second = receiptArtifactName("   ");
      expect(first).toMatch(new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-[a-z0-9]+-[a-z0-9]+$`));
      expect(second).toMatch(new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-[a-z0-9]+-[a-z0-9]+$`));
      expect(first).not.toBe(RECEIPT_ARTIFACT_PREFIX);
      expect(second).not.toBe(RECEIPT_ARTIFACT_PREFIX);
    });
  });

  describe("uploadReport retry policy and collision escalation", () => {
    it("exposes MAX_REPORT_UPLOAD_ATTEMPTS = 3", () => {
      expect(MAX_REPORT_UPLOAD_ATTEMPTS).toBe(3);
    });

    it("escalates from stable name -> differentiator fallback -> unique suffixed name across 3 attempts", async () => {
      uploadArtifactMock
        .mockRejectedValueOnce(makeConflictError("first collision on default name"))
        .mockRejectedValueOnce(makeConflictError("second collision on differentiator name"))
        .mockResolvedValueOnce({ id: 303, size: 512 });

      const outcome = await uploadReport(REPORT_PATH, "protocol-28", 14, [
        "/tmp/canary-run/junit.xml",
      ]);

      expect(uploadArtifactMock).toHaveBeenCalledTimes(MAX_REPORT_UPLOAD_ATTEMPTS);
      const attempt1Name = uploadArtifactMock.mock.calls[0]?.[0] as string;
      const attempt2Name = uploadArtifactMock.mock.calls[1]?.[0] as string;
      const attempt3Name = uploadArtifactMock.mock.calls[2]?.[0] as string;

      expect(attempt1Name).toBe(ARTIFACT_NAME);
      expect(attempt2Name).toBe(`${ARTIFACT_NAME}-protocol-28`);
      expect(attempt3Name).toMatch(
        new RegExp(`^${ARTIFACT_NAME}-protocol-28-[a-z0-9]+-[a-z0-9]+$`),
      );

      expect(outcome).toEqual({
        uploaded: true,
        name: attempt3Name,
        id: 303,
      });

      for (let i = 0; i < MAX_REPORT_UPLOAD_ATTEMPTS; i += 1) {
        expect(uploadArtifactMock).toHaveBeenNthCalledWith(
          i + 1,
          uploadArtifactMock.mock.calls[i]?.[0],
          [REPORT_PATH, "/tmp/canary-run/junit.xml"],
          REPORT_DIR,
          { retentionDays: 14 },
        );
      }
      expect(infoMock).toHaveBeenCalledTimes(3);
      expect(warningMock).not.toHaveBeenCalled();
    });

    it("generates distinct unique fallback names on attempts 2 and 3 when no differentiator is supplied", async () => {
      uploadArtifactMock
        .mockRejectedValueOnce(makeConflictError())
        .mockRejectedValueOnce(makeConflictError())
        .mockResolvedValueOnce({ id: 404, size: 256 });

      const outcome = await uploadReport(REPORT_PATH);

      expect(uploadArtifactMock).toHaveBeenCalledTimes(3);
      const names = uploadArtifactMock.mock.calls.map((c) => c[0] as string);
      expect(names[0]).toBe(ARTIFACT_NAME);
      expect(names[1]).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
      expect(names[2]).toMatch(new RegExp(`^${ARTIFACT_NAME}-[a-z0-9]+-[a-z0-9]+$`));
      expect(new Set(names).size).toBe(3);
      expect(outcome).toEqual({ uploaded: true, name: names[2], id: 404 });
    });

    it("stops after MAX_REPORT_UPLOAD_ATTEMPTS (3) collisions and reports structured failure diagnostics", async () => {
      const finalCollision = makeConflictError("all 3 candidate names collided");
      uploadArtifactMock
        .mockRejectedValueOnce(makeConflictError("collision 1"))
        .mockRejectedValueOnce(makeConflictError("collision 2"))
        .mockRejectedValueOnce(finalCollision);

      const outcome = await uploadReport(REPORT_PATH, "matrix-leg-a");

      expect(uploadArtifactMock).toHaveBeenCalledTimes(MAX_REPORT_UPLOAD_ATTEMPTS);
      expect(outcome.uploaded).toBe(false);
      expect(outcome.reason).toContain("all 3 candidate names collided");
      expect(outcome.name).toBeUndefined();
      expect(outcome.id).toBeUndefined();
      expect(warningMock).toHaveBeenCalledTimes(1);
      expect(warningMock.mock.calls[0]?.[0]).toContain("all 3 candidate names collided");
    });

    it("does not retry non-collision network failures on attempt 1 and surfaces structured diagnostics", async () => {
      uploadArtifactMock.mockRejectedValueOnce(
        new Error("Transient socket failure: ECONNRESET while streaming chunk"),
      );

      const outcome = await uploadReport(
        REPORT_PATH,
        "protocol-28",
        ["/tmp/canary-run/extra.txt"],
        7,
      );

      expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
      expect(uploadArtifactMock).toHaveBeenCalledWith(
        ARTIFACT_NAME,
        [REPORT_PATH, "/tmp/canary-run/extra.txt"],
        REPORT_DIR,
        { retentionDays: 7 },
      );
      expect(outcome).toEqual({
        uploaded: false,
        reason: "Transient socket failure: ECONNRESET while streaming chunk",
      });
      expect(warningMock).toHaveBeenCalledWith(
        `Failed to upload ${ARTIFACT_NAME} artifact: Transient socket failure: ECONNRESET while streaming chunk`,
      );
    });

    it("aborts retry loop immediately if attempt 2 fails with a non-collision error after an initial 409", async () => {
      uploadArtifactMock
        .mockRejectedValueOnce(makeConflictError("primary name taken"))
        .mockRejectedValueOnce(new Error("HTTP 502 Bad Gateway from blob storage"));

      const outcome = await uploadReport(REPORT_PATH, "protocol-28");

      expect(uploadArtifactMock).toHaveBeenCalledTimes(2);
      expect(outcome).toEqual({
        uploaded: false,
        reason: "HTTP 502 Bad Gateway from blob storage",
      });
      expect(warningMock).toHaveBeenCalledWith(
        `Failed to upload ${ARTIFACT_NAME}-protocol-28 artifact: HTTP 502 Bad Gateway from blob storage`,
      );
    });
  });

  describe("uploadReceipt collision fallback and permanent failure diagnostics", () => {
    it("uploads under run-scoped receiptArtifactName and retries once with a unique suffix on 409 collision", async () => {
      process.env.GITHUB_RUN_ID = "778899";
      uploadArtifactMock
        .mockRejectedValueOnce(makeConflictError("receipt name already exists"))
        .mockResolvedValueOnce({ id: 901, size: 64 });

      const outcome = await uploadReceipt(RECEIPT_PATH, 30);

      expect(uploadArtifactMock).toHaveBeenCalledTimes(2);
      const firstAttemptName = uploadArtifactMock.mock.calls[0]?.[0] as string;
      const secondAttemptName = uploadArtifactMock.mock.calls[1]?.[0] as string;

      expect(firstAttemptName).toBe(`${RECEIPT_ARTIFACT_PREFIX}-778899`);
      expect(secondAttemptName).toMatch(
        new RegExp(`^${RECEIPT_ARTIFACT_PREFIX}-778899-[a-z0-9]+-[a-z0-9]+$`),
      );
      expect(outcome).toEqual({
        uploaded: true,
        name: secondAttemptName,
        id: 901,
      });
      expect(warningMock).not.toHaveBeenCalled();
    });

    it("returns structured failure diagnostics when both primary and fallback receipt uploads collide", async () => {
      process.env.GITHUB_RUN_ID = "778899";
      uploadArtifactMock
        .mockRejectedValueOnce(makeConflictError("first receipt collision"))
        .mockRejectedValueOnce(makeConflictError("second receipt collision"));

      const outcome = await uploadReceipt(RECEIPT_PATH);

      expect(uploadArtifactMock).toHaveBeenCalledTimes(2);
      expect(outcome.uploaded).toBe(false);
      expect(outcome.reason).toContain("second receipt collision");
      expect(warningMock).toHaveBeenCalledTimes(1);
    });

    it("returns structured failure diagnostics without retrying when receipt upload encounters a non-collision error", async () => {
      process.env.GITHUB_RUN_ID = "778899";
      uploadArtifactMock.mockRejectedValueOnce(new Error("503 Artifact backend unavailable"));

      const outcome = await uploadReceipt(RECEIPT_PATH);

      expect(uploadArtifactMock).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({
        uploaded: false,
        reason: "503 Artifact backend unavailable",
      });
      expect(warningMock).toHaveBeenCalledWith(
        `Failed to upload ${RECEIPT_ARTIFACT_PREFIX}-778899 artifact: 503 Artifact backend unavailable`,
      );
    });
  });
});
