import type { CellFacts, ClassifiedCell, ExpectationEntry } from "./classify-compat.mjs";

export interface CellFactsEnvironment {
  CELL_ID?: string;
  ENGINE_REF?: string;
  PACK_REF?: string;
  ENGINE_COMMIT?: string;
  FIXTURES_COMMIT?: string;
  ACTION_COMMIT?: string;
  RUN_URL?: string;
  ENGINE_CHECKOUT_OUTCOME?: string;
  FIXTURES_CHECKOUT_OUTCOME?: string;
  BUILD_OUTCOME?: string;
  CHECK_OUTCOME?: string;
}

export interface MatrixWorkflowIssue {
  type: string;
  reason: string;
  actionCommit: string;
  runUrl: string;
  classification: "infrastructure";
}

export interface MatrixCollectionReport {
  schemaVersion: 1;
  actionCommit: string;
  runUrl: string;
  expectedCellCount: number;
  cells: Array<ClassifiedCell & { facts: CellFacts | null }>;
  issues: MatrixWorkflowIssue[];
  hasFailures: boolean;
  table: string;
}

export function createCellFacts(options: {
  env: CellFactsEnvironment;
  evidenceDir: string;
}): CellFacts;

export function writeCellFacts(options: {
  env: CellFactsEnvironment;
  evidenceDir: string;
}): CellFacts;

export function collectResults(options: {
  matrixJson: string | { include: Array<{ engine_ref: string; pack_ref: string; cell_id: string }> };
  prepareResult: string;
  matrixResult: string;
  artifactRoot: string;
  expectations: ExpectationEntry[] | unknown;
  actionCommit: string;
  runUrl: string;
}): MatrixCollectionReport;

export function writeCollectionOutputs(report: MatrixCollectionReport, outputPath: string): void;
