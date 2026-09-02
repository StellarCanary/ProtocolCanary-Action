import { InvalidReportError } from "./errors";

/**
 * The JSON report shape produced by `stellar-canary check --format json`,
 * as documented in `docs/json-report-contract.md` of
 * `StellarCanary/Protocol-Canary` (schemaVersion 1). This Action treats
 * that document, not this file, as the source of truth — see
 * CONTRIBUTING.md for how to update this type when the schema changes.
 */
export const SUPPORTED_SCHEMA_VERSION = 1;

export type Surface = "xdr" | "rpc" | "soroban";
export type ResultStatus = "pass" | "warning" | "fail" | "error" | "skipped";
export type OverallStatus = "pass" | "warning" | "fail" | "error";

export interface CanaryResult {
  readonly testId: string;
  readonly protocol: number;
  readonly surface: Surface;
  readonly status: ResultStatus;
  readonly summary: string;
  readonly details?: string;
  readonly durationMs: number;
  readonly fixtureId: string | null;
}

export interface CanarySkip {
  readonly fixtureId: string;
  readonly surface: string;
  readonly reason: string;
}

export interface CanaryReport {
  readonly schemaVersion: number;
  readonly toolVersion: string;
  readonly targetProtocol: number;
  readonly project: { readonly name: string; readonly type: string };
  readonly network?: { readonly name: string; readonly observedProtocol?: number };
  readonly status: OverallStatus;
  readonly counts: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly warnings: number;
    readonly errors: number;
    readonly skipped: number;
  };
  readonly results: readonly CanaryResult[];
  readonly skipped?: readonly CanarySkip[];
  readonly git: {
    readonly commit: string | null;
    readonly branch: string | null;
    readonly isDirty: boolean | null;
  };
}

/**
 * Parses Canary's stdout as a report matching the documented schema.
 * Throws {@link InvalidReportError} if the text is not JSON, is not
 * shaped like a report, or declares an unsupported `schemaVersion`.
 */
export function parseReport(stdout: string): CanaryReport {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new InvalidReportError("Canary produced no output to parse as a JSON report.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new InvalidReportError(
      `Canary's output could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidReportError("Canary's JSON output is not a report object.");
  }

  const report = parsed as Partial<CanaryReport>;
  if (typeof report.schemaVersion !== "number") {
    throw new InvalidReportError("Canary's JSON output is missing a numeric \"schemaVersion\" field.");
  }
  if (report.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new InvalidReportError(
      `Unsupported report schemaVersion ${String(report.schemaVersion)} ` +
        `(this Action supports schemaVersion ${String(SUPPORTED_SCHEMA_VERSION)}). ` +
        `A newer Protocol-Canary release may require a newer ProtocolCanary-Action version.`,
    );
  }
  if (
    typeof report.status !== "string" ||
    !["pass", "warning", "fail", "error"].includes(report.status) ||
    !Array.isArray(report.results) ||
    typeof report.counts !== "object" ||
    report.counts === null
  ) {
    throw new InvalidReportError("Canary's JSON output does not match the documented report shape.");
  }

  return report as CanaryReport;
}

export type ExitCodeCategory =
  | "pass"
  | "compatibility_failure"
  | "configuration_error"
  | "execution_error"
  | "invalid_fixture"
  | "internal_error"
  | "unknown";

interface ExitCodeInfo {
  readonly category: ExitCodeCategory;
  readonly description: string;
}

/**
 * The documented `stellar-canary` exit-code contract
 * (`crates/canary-core/src/errors.rs`). This table is the Action's only
 * understanding of what an exit code *means* — it never reinterprets
 * Canary's actual pass/fail decision.
 */
const EXIT_CODES: Readonly<Record<number, ExitCodeInfo>> = {
  0: { category: "pass", description: "Compatibility checks passed." },
  1: { category: "compatibility_failure", description: "A compatibility check failed." },
  2: { category: "configuration_error", description: "Canary configuration is invalid." },
  3: { category: "execution_error", description: "Execution or RPC communication failed." },
  4: { category: "invalid_fixture", description: "One or more fixtures are invalid." },
  5: { category: "internal_error", description: "Canary encountered an internal error." },
};

export function describeExitCode(code: number): ExitCodeInfo {
  return EXIT_CODES[code] ?? { category: "unknown", description: `Unrecognized exit code ${String(code)}.` };
}
