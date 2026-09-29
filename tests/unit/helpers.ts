import type { CanaryReport, CanaryResult } from "../../src/output";

/**
 * Shared builders for CanaryReport/CanaryResult test fixtures.
 *
 * Previously each of annotations.test.ts, summary.test.ts, and
 * output.test.ts defined its own near-identical local copy; a schema change
 * (e.g. a new required top-level field) meant updating three places that
 * could silently drift. Import these instead.
 */
export function result(overrides: Partial<CanaryResult> = {}): CanaryResult {
  return {
    testId: "t",
    protocol: 28,
    surface: "xdr",
    status: "pass",
    summary: "ok",
    durationMs: 1,
    fixtureId: "t",
    ...overrides,
  };
}

export function report(resultsOrOverrides: CanaryResult[] | Partial<CanaryReport> = {}): CanaryReport {
  const defaults: CanaryReport = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    targetProtocol: 28,
    project: { name: "example-project", type: "soroban" },
    status: "pass",
    counts: { total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
    results: [],
    git: { commit: null, branch: null, isDirty: null },
  };
  if (Array.isArray(resultsOrOverrides)) {
    const results = resultsOrOverrides;
    return {
      ...defaults,
      counts: { total: results.length, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
      results,
    };
  }
  return { ...defaults, ...resultsOrOverrides };
}
