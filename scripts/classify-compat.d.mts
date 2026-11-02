/**
 * Classification logic for compatibility matrix cells.
 */

export type CellClassification =
  | "supported"
  | "expected-incompatible"
  | "infrastructure"
  | "skipped"
  | "unexpected-failure"
  | "unexpected-pass";

export interface CellFacts {
  schemaVersion: 1;
  cellId: string;
  engineRef: string;
  packRef: string;
  engineCommit: string | null;
  fixturesCommit: string | null;
  actionCommit: string;
  runUrl: string;
  engineCheckoutOutcome: "success" | "failure" | "cancelled" | "skipped";
  fixturesCheckoutOutcome: "success" | "failure" | "cancelled" | "skipped";
  buildOutcome: "success" | "failure" | "timeout" | "cancelled" | "skipped";
  checkOutcome: "completed" | "failure" | "timeout" | "cancelled" | "skipped" | "unknown";
  checkExitCode: number | null;
  actionStatus: "pass" | "warning" | "fail" | "error" | "execution-failed" | null;
  passed: number | null;
  failures: number | null;
  warnings: number | null;
  errors: number | null;
  replayedCount: number | null;
  total: number | null;
  firstDiagnostic: string;
  ranNoChecks: boolean;
  evidenceError: string | null;
  evidenceFiles: string[];
}

export interface ExpectationEntry {
  engineRef: string;
  packRef: string;
  expectedStatus: "fail" | "error" | "execution-failed";
  failureSignature: string;
  runUrl: string;
  dateAdded: string;
  reason: string;
}

export interface ClassifiedCell {
  engineRef: string;
  packRef: string;
  actionCommit: string;
  runUrl: string;
  classification: CellClassification;
  reason: string;
  evidence: string;
}

export function classifyCell(
  facts: CellFacts,
  expectations: readonly ExpectationEntry[],
): ClassifiedCell;

export function shouldFailJob(classification: CellClassification): boolean;

export function formatCellRow(cell: ClassifiedCell): string;

export function formatResultsTable(cells: readonly ClassifiedCell[]): string;
