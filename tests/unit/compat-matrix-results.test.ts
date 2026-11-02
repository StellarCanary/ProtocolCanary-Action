import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMatrix } from "../../scripts/compat-matrix-inputs.mjs";
import {
  collectResults,
  writeCellFacts,
  writeCollectionOutputs,
} from "../../scripts/compat-matrix-results.mjs";

const ACTION_COMMIT = "action-commit-123";
const RUN_URL = "https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/123";
const ENGINE_COMMIT = "a".repeat(40);
const FIXTURES_COMMIT = "b".repeat(40);
const directories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "compat-matrix-results-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function report(status: "pass" | "fail" = "pass", empty = false) {
  return {
    schemaVersion: 1,
    toolVersion: "0.2.0",
    targetProtocol: 28,
    project: { name: "fixtures", type: "generic-stellar" },
    status,
    counts: {
      total: empty ? 0 : 1,
      passed: !empty && status === "pass" ? 1 : 0,
      failed: !empty && status === "fail" ? 1 : 0,
      warnings: 0,
      errors: 0,
      skipped: 0,
    },
    results: empty
      ? []
      : [{
          testId: "fixture-1",
          protocol: 28,
          surface: "xdr",
          status,
          summary: status === "fail" ? "CAP-100 mismatch in transaction envelope" : "Fixture passed",
          durationMs: 4,
        }],
  };
}

function matrix() {
  return buildMatrix(["v0.1.1"], ["protocol-28"]);
}

function onlyCell() {
  const cell = matrix().include[0];
  if (!cell) throw new Error("Expected one compatibility matrix cell");
  return cell;
}

function createArtifact(root: string, cell = onlyCell(), options: {
  report?: unknown;
  exitCode?: string;
  engineRef?: string;
  packRef?: string;
  executionMode?: string;
  stderr?: string;
  factsContent?: string;
} = {}) {
  const evidenceDir = path.join(root, `cell-facts-${cell.cell_id}`);
  mkdirSync(evidenceDir, { recursive: true });
  if (options.factsContent !== undefined) {
    writeFileSync(path.join(evidenceDir, "cell-facts.json"), options.factsContent);
    return evidenceDir;
  }

  writeFileSync(
    path.join(evidenceDir, "report.json"),
    options.report === undefined ? "" : JSON.stringify(options.report),
  );
  writeFileSync(path.join(evidenceDir, "build.stdout"), "cargo install succeeded\n");
  writeFileSync(path.join(evidenceDir, "build.stderr"), "");
  writeFileSync(path.join(evidenceDir, "stderr.txt"), options.stderr ?? "");
  writeFileSync(path.join(evidenceDir, "exit-code.txt"), options.exitCode ?? "0");
  const facts = writeCellFacts({
    evidenceDir,
    env: {
      CELL_ID: cell.cell_id,
      ENGINE_REF: options.engineRef ?? cell.engine_ref,
      PACK_REF: options.packRef ?? cell.pack_ref,
      EXECUTION_MODE: options.executionMode ?? "offline-xdr",
      ENGINE_COMMIT,
      FIXTURES_COMMIT,
      ACTION_COMMIT,
      RUN_URL,
      ENGINE_CHECKOUT_OUTCOME: "success",
      FIXTURES_CHECKOUT_OUTCOME: "success",
      BUILD_OUTCOME: "success",
      CHECK_OUTCOME: "success",
    },
  });
  expect(facts.evidenceFiles).toEqual([
    "build.stderr",
    "build.stdout",
    "exit-code.txt",
    "report.json",
    "stderr.txt",
  ]);
  return evidenceDir;
}

function collect(artifactRoot: string, options: Record<string, unknown> = {}) {
  return collectResults({
    matrixJson: matrix(),
    prepareResult: "success",
    matrixResult: "success",
    artifactRoot,
    expectations: [],
    actionCommit: ACTION_COMMIT,
    runUrl: RUN_URL,
    executionMode: "offline-xdr",
    ...options,
  } as Parameters<typeof collectResults>[0]);
}

describe("compatibility matrix cell evidence", () => {
  it("generates structured facts with refs, outcomes and retained CLI evidence", () => {
    const artifactRoot = temporaryDirectory();
    const cell = onlyCell();
    const evidenceDir = createArtifact(artifactRoot, cell, { report: report() });

    const facts = JSON.parse(readFileSync(path.join(evidenceDir, "cell-facts.json"), "utf8"));
    expect(facts).toMatchObject({
      schemaVersion: 1,
      cellId: cell.cell_id,
      engineRef: "v0.1.1",
      packRef: "protocol-28",
      executionMode: "offline-xdr",
      engineCommit: ENGINE_COMMIT,
      fixturesCommit: FIXTURES_COMMIT,
      actionCommit: ACTION_COMMIT,
      engineCheckoutOutcome: "success",
      fixturesCheckoutOutcome: "success",
      buildOutcome: "success",
      checkOutcome: "completed",
      actionStatus: "pass",
      passed: 1,
      total: 1,
      ranNoChecks: false,
      evidenceError: null,
    });
    expect(facts.evidenceFiles).toEqual([
      "build.stderr",
      "build.stdout",
      "exit-code.txt",
      "report.json",
      "stderr.txt",
    ]);
  });

  it("prefers an execution error in stderr over an earlier warning", () => {
    const evidenceDir = temporaryDirectory();
    writeFileSync(path.join(evidenceDir, "stderr.txt"), [
      "warning: the RPC endpoint reports protocol 29, but this run targets protocol 28",
      "error: invalid fixture: unsupported fixture body value",
      "",
    ].join("\n"));
    writeFileSync(path.join(evidenceDir, "exit-code.txt"), "4\n");

    const facts = writeCellFacts({
      evidenceDir,
      env: {
        CELL_ID: onlyCell().cell_id,
        ENGINE_REF: "v0.2.0",
        PACK_REF: "main",
        EXECUTION_MODE: "offline-xdr",
        ENGINE_COMMIT,
        FIXTURES_COMMIT,
        ACTION_COMMIT,
        RUN_URL,
        ENGINE_CHECKOUT_OUTCOME: "success",
        FIXTURES_CHECKOUT_OUTCOME: "success",
        BUILD_OUTCOME: "success",
        CHECK_OUTCOME: "success",
      },
    });

    expect(facts.firstDiagnostic).toBe("error: invalid fixture: unsupported fixture body value");
  });

  it("classifies deterministic fixture parser failures as compatibility failures", () => {
    const diagnostics = [
      {
        exitCode: "3",
        stderr: 'error: soroban error: invalid soroban fixture body in fixtures/protocol-28/soroban/p28-soroban-sim-error-arg-type.toml: unsupported arg kind "i128"',
      },
      {
        exitCode: "4",
        stderr: 'error: invalid fixture: invalid soroban fixture body in fixtures/protocol-28/soroban/p28-soroban-sim-error-arg-type.toml: unsupported arg kind "i128"',
      },
      {
        exitCode: "3",
        stderr: 'error: xdr error: invalid xdr fixture body in fixtures/protocol-28/xdr/ledger-entry/p28-xdr-ledger-entry-account-truncated.toml: unsupported XDR type name "LedgerEntry": supported types are: StellarValue, ContractExecutable',
      },
      {
        exitCode: "4",
        stderr: 'error: invalid fixture: invalid xdr fixture body in fixtures/protocol-28/xdr/ledger-entry/p28-xdr-ledger-entry-account-truncated.toml: unsupported XDR type name "LedgerEntry": supported types are: StellarValue, ContractExecutable, ScVal',
      },
    ];

    for (const { exitCode, stderr } of diagnostics) {
      const artifactRoot = temporaryDirectory();
      createArtifact(artifactRoot, onlyCell(), { exitCode, stderr });

      const result = collect(artifactRoot);
      expect(result.cells[0]!.classification).toBe("unexpected-failure");
      expect(result.cells[0]!.reason).toContain("Engine rejected fixture data before compatibility checks");
      expect(result.cells[0]!.reason).toMatch(/unsupported arg kind "i128"|unsupported XDR type name "LedgerEntry"/);
      expect(result.cells[0]!.facts?.cliFailureKind).toBe("fixture-parse");
    }
  });

  it("keeps report-less RPC transport failures classified as infrastructure", () => {
    const artifactRoot = temporaryDirectory();
    createArtifact(artifactRoot, onlyCell(), {
      exitCode: "3",
      stderr: "error: RPC request failed: connection refused",
    });

    const result = collect(artifactRoot);
    expect(result.cells[0]!.classification).toBe("infrastructure");
    expect(result.cells[0]!.reason).toContain("Execution evidence is incomplete");
    expect(result.cells[0]!.facts?.cliFailureKind).toBeNull();
  });

  it("classifies a retrieved artifact using its actual execution facts", () => {
    const artifactRoot = temporaryDirectory();
    createArtifact(artifactRoot, onlyCell(), { report: report() });

    const result = collect(artifactRoot);
    expect(result.expectedCellCount).toBe(1);
    expect(result.executionMode).toBe("offline-xdr");
    expect(result.cells[0]!.classification).toBe("supported");
    expect(result.cells[0]!.facts?.engineRef).toBe("v0.1.1");
    expect(result.hasFailures).toBe(false);
  });

  it("rejects cell artifacts that do not identify the offline execution mode", () => {
    const artifactRoot = temporaryDirectory();
    createArtifact(artifactRoot, onlyCell(), { report: report(), executionMode: "live" });

    const result = collect(artifactRoot);
    expect(result.cells[0]!.classification).toBe("infrastructure");
    expect(result.cells[0]!.reason).toContain("execution mode");
    expect(result.hasFailures).toBe(true);
  });

  it("classifies missing and malformed artifacts as infrastructure failures", () => {
    const missing = collect(temporaryDirectory());
    expect(missing.cells[0]!.classification).toBe("infrastructure");
    expect(missing.cells[0]!.reason).toContain("artifact");
    expect(missing.hasFailures).toBe(true);

    const malformedRoot = temporaryDirectory();
    createArtifact(malformedRoot, onlyCell(), { factsContent: "{invalid" });
    const malformed = collect(malformedRoot);
    expect(malformed.cells[0]!.classification).toBe("infrastructure");
    expect(malformed.cells[0]!.reason).toContain("malformed JSON");
    expect(malformed.hasFailures).toBe(true);
  });

  it("does not accept facts when their raw report evidence is absent from the artifact", () => {
    const artifactRoot = temporaryDirectory();
    const evidenceDir = createArtifact(artifactRoot, onlyCell(), { report: report() });
    unlinkSync(path.join(evidenceDir, "report.json"));

    const result = collect(artifactRoot);
    expect(result.cells[0]!.classification).toBe("infrastructure");
    expect(result.cells[0]!.reason).toContain("files do not match");
    expect(result.hasFailures).toBe(true);
  });

  it("rejects cell facts that identify different refs or an incomplete report", () => {
    const wrongRefRoot = temporaryDirectory();
    createArtifact(wrongRefRoot, onlyCell(), { report: report(), engineRef: "v0.2.0" });
    expect(collect(wrongRefRoot).cells[0]!.classification).toBe("infrastructure");

    const malformedReportRoot = temporaryDirectory();
    createArtifact(malformedReportRoot, onlyCell(), { report: { schemaVersion: 1 } });
    const malformedReport = collect(malformedReportRoot);
    expect(malformedReport.cells[0]!.classification).toBe("infrastructure");
    expect(malformedReport.cells[0]!.reason).toContain("Execution evidence is incomplete");
  });

  it("keeps expected incompatibilities distinct and fails timeouts before expectation matching", () => {
    const expected = [{
      engineRef: "v0.1.1",
      packRef: "protocol-28",
      expectedStatus: "fail" as const,
      failureSignature: "CAP-100 mismatch",
      runUrl: "https://example.com/evidence",
      dateAdded: "2026-01-01",
      reason: "Documented CAP-100 incompatibility",
    }];
    const expectedRoot = temporaryDirectory();
    createArtifact(expectedRoot, onlyCell(), { report: report("fail") });
    const expectedResult = collect(expectedRoot, { expectations: expected });
    expect(expectedResult.cells[0]!.classification).toBe("expected-incompatible");
    expect(expectedResult.hasFailures).toBe(false);

    const timeoutRoot = temporaryDirectory();
    createArtifact(timeoutRoot, onlyCell(), { report: report(), exitCode: "124" });
    const timeoutResult = collect(timeoutRoot, { expectations: expected });
    expect(timeoutResult.cells[0]!.classification).toBe("infrastructure");
    expect(timeoutResult.hasFailures).toBe(true);
  });

  it("records zero-check reports as skipped rather than supported", () => {
    const artifactRoot = temporaryDirectory();
    createArtifact(artifactRoot, onlyCell(), { report: report("pass", true) });
    const result = collect(artifactRoot);
    expect(result.cells[0]!.classification).toBe("skipped");
    expect(result.hasFailures).toBe(false);
  });

  it("publishes TABLE and HAS_FAILURES as GitHub step outputs", () => {
    const artifactRoot = temporaryDirectory();
    const result = collect(artifactRoot);
    const outputPath = path.join(artifactRoot, "github-output.txt");
    writeCollectionOutputs(result, outputPath);
    const output = readFileSync(outputPath, "utf8");
    expect(output).toMatch(/^TABLE<<COMPAT_[a-f0-9]+\n/m);
    expect(output).toContain("| Engine | Pack | Classification | Reason | Evidence |");
    expect(output).toContain("HAS_FAILURES=true");
  });

  it("reports a matrix job that fails even if cell artifacts look successful", () => {
    const artifactRoot = temporaryDirectory();
    createArtifact(artifactRoot, onlyCell(), { report: report() });
    const result = collect(artifactRoot, { matrixResult: "failure" });
    expect(result.cells[0]!.classification).toBe("supported");
    expect(result.issues.some((issue) => issue.type === "matrix-job")).toBe(true);
    expect(result.hasFailures).toBe(true);
  });
});
