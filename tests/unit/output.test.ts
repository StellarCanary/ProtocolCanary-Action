import { describe, expect, it } from "vitest";

import { InvalidReportError } from "../../src/errors";
import { describeExitCode, parseReport } from "../../src/output";

const VALID_REPORT = JSON.stringify({
  schemaVersion: 1,
  toolVersion: "0.1.0",
  targetProtocol: 28,
  project: { name: "example-project", type: "soroban" },
  status: "pass",
  counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
  results: [
    {
      testId: "p28-xdr-cap83-empty-tx-set",
      protocol: 28,
      surface: "xdr",
      status: "pass",
      summary: "StellarValue round-tripped byte-for-byte",
      durationMs: 1,
      fixtureId: "p28-xdr-cap83-empty-tx-set",
    },
  ],
  git: { commit: "68a5f8d", branch: "main", isDirty: false },
});

describe("parseReport", () => {
  it("parses a well-formed report", () => {
    const report = parseReport(VALID_REPORT);
    expect(report.status).toBe("pass");
    expect(report.counts.total).toBe(1);
  });

  it("tolerates surrounding whitespace", () => {
    expect(() => parseReport(`\n  ${VALID_REPORT}  \n`)).not.toThrow();
  });

  it("rejects empty output", () => {
    expect(() => parseReport("")).toThrow(InvalidReportError);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseReport("{ not json")).toThrow(InvalidReportError);
  });

  it("rejects JSON that is not an object", () => {
    expect(() => parseReport("[1, 2, 3]")).toThrow(InvalidReportError);
  });

  it("rejects a report missing schemaVersion", () => {
    const { schemaVersion: _schemaVersion, ...rest } = JSON.parse(VALID_REPORT) as Record<string, unknown>;
    expect(() => parseReport(JSON.stringify(rest))).toThrow(InvalidReportError);
  });

  it("rejects an unsupported schemaVersion", () => {
    const report = { ...JSON.parse(VALID_REPORT), schemaVersion: 2 };
    expect(() => parseReport(JSON.stringify(report))).toThrow(InvalidReportError);
  });

  it("rejects a report with an unrecognized status", () => {
    const report = { ...JSON.parse(VALID_REPORT), status: "unknown" };
    expect(() => parseReport(JSON.stringify(report))).toThrow(InvalidReportError);
  });
});

describe("describeExitCode", () => {
  it("maps every documented exit code", () => {
    expect(describeExitCode(0).category).toBe("pass");
    expect(describeExitCode(1).category).toBe("compatibility_failure");
    expect(describeExitCode(2).category).toBe("configuration_error");
    expect(describeExitCode(3).category).toBe("execution_error");
    expect(describeExitCode(4).category).toBe("invalid_fixture");
    expect(describeExitCode(5).category).toBe("internal_error");
  });

  it("falls back to unknown for an unrecognized code", () => {
    expect(describeExitCode(99).category).toBe("unknown");
  });
});
