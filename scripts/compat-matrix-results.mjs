import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyCell,
  formatResultsTable,
  shouldFailJob,
} from "./classify-compat.mjs";

const CHECK_STATUSES = new Set(["pass", "warning", "fail", "error"]);
const CHECK_OUTCOMES = new Set(["completed", "failure", "timeout", "cancelled", "skipped", "unknown"]);
const STEP_OUTCOMES = new Set(["success", "failure", "cancelled", "skipped"]);
const COUNT_FIELDS = ["total", "passed", "failed", "warnings", "errors"];
const PROJECT_TYPES = new Set(["soroban", "rpc-consumer", "stellar-sdk", "generic-stellar", "unknown"]);
const RESULT_SURFACES = new Set(["xdr", "rpc", "soroban"]);
const MAX_DIAGNOSTIC_LENGTH = 512;
const FIXTURE_PARSE_DIAGNOSTIC = /\b(?:invalid (?:soroban |xdr )?fixture(?: body)?|failed to parse fixture|unsupported arg kind)\b/i;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function readText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseExitCode(filePath) {
  const value = readText(filePath).trim();
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseCliReport(reportPath) {
  const raw = readText(reportPath);
  if (!raw.trim()) return { error: "The CLI report is missing or empty." };

  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    return { error: `The CLI report is malformed JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!isObject(report)) return { error: "The CLI report must be a JSON object." };
  if (report.schemaVersion !== 1) return { error: "The CLI report has an unsupported or missing schemaVersion." };
  if (!nonEmptyString(report.toolVersion)) return { error: "The CLI report has a missing or invalid toolVersion." };
  if (!Number.isSafeInteger(report.targetProtocol) || report.targetProtocol < 1) {
    return { error: "The CLI report has a missing or invalid targetProtocol." };
  }
  if (
    !isObject(report.project) ||
    !nonEmptyString(report.project.name) ||
    !PROJECT_TYPES.has(report.project.type)
  ) {
    return { error: "The CLI report has a missing or invalid project object." };
  }
  if (!CHECK_STATUSES.has(report.status)) return { error: "The CLI report has a missing or invalid status." };
  if (!isObject(report.counts)) return { error: "The CLI report has a missing or invalid counts object." };
  if (!Array.isArray(report.results)) return { error: "The CLI report has a missing or invalid results array." };

  for (const field of COUNT_FIELDS) {
    if (!validCount(report.counts[field])) {
      return { error: `The CLI report has an invalid counts.${field} value.` };
    }
  }
  if (report.counts.skipped !== undefined && !validCount(report.counts.skipped)) {
    return { error: "The CLI report has an invalid counts.skipped value." };
  }
  if (report.counts.total !== report.results.length) {
    return { error: "The CLI report counts.total does not match the number of result entries." };
  }
  if (report.counts.passed + report.counts.failed + report.counts.warnings + report.counts.errors !== report.counts.total) {
    return { error: "The CLI report outcome counts do not add up to counts.total." };
  }
  if (report.results.some((result) => (
    !isObject(result) ||
    !nonEmptyString(result.testId) ||
    !Number.isSafeInteger(result.protocol) ||
    result.protocol < 1 ||
    !RESULT_SURFACES.has(result.surface) ||
    !CHECK_STATUSES.has(result.status) ||
    !nonEmptyString(result.summary) ||
    !Number.isSafeInteger(result.durationMs) ||
    result.durationMs < 0
  ))) {
    return { error: "The CLI report contains a malformed result entry or an unknown result value." };
  }

  const countsByStatus = { pass: 0, warning: 0, fail: 0, error: 0 };
  for (const result of report.results) countsByStatus[result.status] += 1;
  if (
    countsByStatus.pass !== report.counts.passed ||
    countsByStatus.warning !== report.counts.warnings ||
    countsByStatus.fail !== report.counts.failed ||
    countsByStatus.error !== report.counts.errors
  ) {
    return { error: "The CLI report outcome counts do not match the result entries." };
  }
  const statusFromCounts = report.counts.errors > 0
    ? "error"
    : report.counts.failed > 0
      ? "fail"
      : report.counts.warnings > 0
        ? "warning"
        : "pass";
  if (report.status !== statusFromCounts) {
    return { error: "The CLI report status does not match its outcome counts." };
  }

  return { report };
}

function firstDiagnostic(report, stderr) {
  if (report) {
    for (const result of report.results) {
      if (["fail", "error", "warning"].includes(result.status)) {
        const detail = typeof result.details === "string" ? result.details : "";
        const summary = typeof result.summary === "string" ? result.summary : "";
        const message = detail || summary;
        if (message.trim()) return message.trim().split(/\r?\n/, 1)[0].slice(0, MAX_DIAGNOSTIC_LENGTH);
      }
    }
  }
  const stderrLines = stderr.trim().split(/\r?\n/).filter((line) => line.trim());
  const failureLine = stderrLines.find((line) => /^\s*(?:error:|fatal:|failed(?:\s|:))/i.test(line));
  return (failureLine ?? stderrLines[0] ?? "").slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function cliFailureKind(exitCode, hasReport, stderr) {
  if (hasReport || exitCode === null || exitCode === 0) return null;
  return FIXTURE_PARSE_DIAGNOSTIC.test(stderr) ? "fixture-parse" : null;
}

function normalizedStepOutcome(value) {
  return STEP_OUTCOMES.has(value) ? value : "unknown";
}

function normalizedCommit(value) {
  return typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function readEvidenceFiles(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== "cell-facts.json")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function createCellFacts({ env = process.env, evidenceDir }) {
  if (!nonEmptyString(evidenceDir)) throw new Error("An evidence directory is required");
  mkdirSync(evidenceDir, { recursive: true });

  const reportPath = path.join(evidenceDir, "report.json");
  const stderr = readText(path.join(evidenceDir, "stderr.txt"));
  const exitCode = parseExitCode(path.join(evidenceDir, "exit-code.txt"));
  const parsed = parseCliReport(reportPath);
  const report = parsed.report;
  const diagnostic = firstDiagnostic(report, stderr);
  const checkStepOutcome = env.CHECK_OUTCOME ?? "unknown";
  let checkOutcome = "unknown";
  if (exitCode === 124 || exitCode === 137 || exitCode === 143) checkOutcome = "timeout";
  else if (checkStepOutcome === "cancelled") checkOutcome = "cancelled";
  else if (checkStepOutcome === "skipped") checkOutcome = "skipped";
  else if (checkStepOutcome === "failure") checkOutcome = "failure";
  else if (checkStepOutcome === "success" && exitCode !== null) checkOutcome = "completed";
  else if (checkStepOutcome === "success") checkOutcome = "failure";

  const buildOutcome = normalizedStepOutcome(env.BUILD_OUTCOME ?? "unknown");
  const facts = {
    schemaVersion: 1,
    cellId: env.CELL_ID ?? "",
    engineRef: env.ENGINE_REF ?? "",
    packRef: env.PACK_REF ?? "",
    engineCommit: normalizedCommit(env.ENGINE_COMMIT),
    fixturesCommit: normalizedCommit(env.FIXTURES_COMMIT),
    actionCommit: env.ACTION_COMMIT ?? "",
    runUrl: env.RUN_URL ?? "",
    executionMode: env.EXECUTION_MODE ?? "",
    engineCheckoutOutcome: normalizedStepOutcome(env.ENGINE_CHECKOUT_OUTCOME ?? "unknown"),
    fixturesCheckoutOutcome: normalizedStepOutcome(env.FIXTURES_CHECKOUT_OUTCOME ?? "unknown"),
    buildOutcome,
    checkOutcome,
    checkExitCode: exitCode,
    actionStatus: report?.status ?? null,
    cliFailureKind: cliFailureKind(exitCode, report !== undefined, stderr),
    passed: report?.counts.passed ?? null,
    failures: report?.counts.failed ?? null,
    warnings: report?.counts.warnings ?? null,
    errors: report?.counts.errors ?? null,
    total: report?.counts.total ?? null,
    replayedCount: report?.results.filter((result) => result.source === "cache").length ?? null,
    firstDiagnostic: diagnostic,
    ranNoChecks: report !== undefined && report.counts.total === 0,
    evidenceError: parsed.error ?? null,
    evidenceFiles: readEvidenceFiles(evidenceDir),
  };

  if (!facts.evidenceError && !report) facts.evidenceError = "No usable CLI report was recorded.";
  if (exitCode === null && checkOutcome === "completed") {
    facts.evidenceError = "The CLI exit code is missing or malformed.";
  }
  if (!CHECK_OUTCOMES.has(facts.checkOutcome)) {
    facts.evidenceError = `Unknown check outcome: ${facts.checkOutcome}`;
    facts.checkOutcome = "unknown";
  }
  return facts;
}

export function writeCellFacts(options) {
  const facts = createCellFacts(options);
  writeFileSync(path.join(options.evidenceDir, "cell-facts.json"), `${JSON.stringify(facts, null, 2)}\n`, "utf8");
  return facts;
}

function workflowIssue(type, reason, actionCommit, runUrl) {
  return {
    type,
    reason,
    actionCommit,
    runUrl,
    classification: "infrastructure",
  };
}

function readMatrix(matrixJson) {
  const value = typeof matrixJson === "string" ? JSON.parse(matrixJson) : matrixJson;
  if (!isObject(value) || !Array.isArray(value.include) || value.include.length === 0) {
    throw new Error("The prepared matrix is missing or has no include cells.");
  }
  const seenIds = new Set();
  const seenPairs = new Set();
  for (const cell of value.include) {
    if (
      !isObject(cell) ||
      !nonEmptyString(cell.engine_ref) ||
      !nonEmptyString(cell.pack_ref) ||
      !nonEmptyString(cell.cell_id) ||
      !/^[a-z0-9-]{1,96}$/.test(cell.cell_id)
    ) {
      throw new Error("The prepared matrix contains a malformed cell.");
    }
    const pair = JSON.stringify([cell.engine_ref, cell.pack_ref]);
    if (seenIds.has(cell.cell_id) || seenPairs.has(pair)) {
      throw new Error("The prepared matrix contains duplicate cell identities or reference pairs.");
    }
    seenIds.add(cell.cell_id);
    seenPairs.add(pair);
  }
  return value.include;
}

function validateCellFacts(facts, expected, actionCommit, artifactDirectory) {
  if (!isObject(facts)) return "The artifact facts must be a JSON object.";
  if (facts.schemaVersion !== 1) return "The artifact facts have an unsupported or missing schemaVersion.";
  if (facts.cellId !== expected.cell_id) return "The artifact cell identity does not match its matrix entry.";
  if (facts.engineRef !== expected.engine_ref || facts.packRef !== expected.pack_ref) {
    return "The artifact references do not match its matrix entry.";
  }
  if (!nonEmptyString(facts.actionCommit) || facts.actionCommit !== actionCommit) {
    return "The artifact Action commit does not match the workflow commit.";
  }
  if (!nonEmptyString(facts.runUrl)) return "The artifact is missing its workflow run URL.";
  if (facts.executionMode !== "offline-xdr") {
    return "The artifact has a missing or unsupported execution mode.";
  }
  if (!STEP_OUTCOMES.has(facts.engineCheckoutOutcome) || !STEP_OUTCOMES.has(facts.fixturesCheckoutOutcome)) {
    return "The artifact has missing or malformed checkout outcomes.";
  }
  if (
    (facts.engineCommit !== null && (typeof facts.engineCommit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(facts.engineCommit))) ||
    (facts.fixturesCommit !== null && (typeof facts.fixturesCommit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(facts.fixturesCommit)))
  ) {
    return "The artifact has a malformed Engine or Fixtures commit SHA.";
  }
  if (facts.engineCheckoutOutcome === "success" && facts.engineCommit === null) {
    return "The Engine checkout succeeded but its commit SHA is missing.";
  }
  if (facts.fixturesCheckoutOutcome === "success" && facts.fixturesCommit === null) {
    return "The Fixtures checkout succeeded but its commit SHA is missing.";
  }
  if (!STEP_OUTCOMES.has(facts.buildOutcome)) return "The artifact has a missing or malformed build outcome.";
  if (!CHECK_OUTCOMES.has(facts.checkOutcome)) return "The artifact has a missing or malformed check outcome.";
  if (facts.checkExitCode !== null && !Number.isSafeInteger(facts.checkExitCode)) {
    return "The artifact has a malformed CLI exit code.";
  }
  if (facts.checkOutcome === "completed" && facts.checkExitCode === null) {
    return "The artifact is missing the CLI exit code.";
  }
  if (facts.actionStatus !== null && !CHECK_STATUSES.has(facts.actionStatus)) {
    return "The artifact has a missing or malformed CLI status.";
  }
  if (facts.cliFailureKind !== null && facts.cliFailureKind !== "fixture-parse") {
    return "The artifact has an unknown CLI failure kind.";
  }
  for (const field of ["passed", "failures", "warnings", "errors", "total", "replayedCount"]) {
    if (facts[field] !== null && !validCount(facts[field])) {
      return `The artifact has an invalid ${field} count.`;
    }
  }
  if (typeof facts.ranNoChecks !== "boolean") return "The artifact has an invalid ranNoChecks value.";
  if (facts.evidenceError !== null && typeof facts.evidenceError !== "string") {
    return "The artifact has an invalid evidenceError value.";
  }
  if (facts.firstDiagnostic !== "" && typeof facts.firstDiagnostic !== "string") {
    return "The artifact has an invalid firstDiagnostic value.";
  }
  if (!Array.isArray(facts.evidenceFiles) || facts.evidenceFiles.some((name) => (
    typeof name !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)
  ))) {
    return "The artifact has an invalid evidenceFiles list.";
  }
  if (new Set(facts.evidenceFiles).size !== facts.evidenceFiles.length) {
    return "The artifact evidenceFiles list contains duplicate names.";
  }
  let actualFiles;
  try {
    const entries = readdirSync(artifactDirectory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() && entry.name !== "cell-facts.json")) {
      return "The cell artifact contains an unexpected directory or non-file entry.";
    }
    actualFiles = entries
      .filter((entry) => entry.isFile() && entry.name !== "cell-facts.json")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return "The cell artifact evidence files are missing or unreadable.";
  }
  const reportedFiles = [...facts.evidenceFiles].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(reportedFiles)) {
    return "The cell artifact files do not match its evidenceFiles list.";
  }
  const requiredFiles = [];
  if (["completed", "timeout"].includes(facts.checkOutcome)) {
    requiredFiles.push("report.json", "stderr.txt", "exit-code.txt");
  } else if (facts.checkOutcome === "failure") {
    requiredFiles.push("stderr.txt");
  }
  if (["success", "failure"].includes(facts.buildOutcome)) {
    requiredFiles.push("build.stdout", "build.stderr");
  }
  if (requiredFiles.some((name) => !actualFiles.includes(name))) {
    return "The cell artifact is missing required execution evidence files.";
  }
  const rawReport = parseCliReport(path.join(artifactDirectory, "report.json"));
  const rawFailureKind = cliFailureKind(
    parseExitCode(path.join(artifactDirectory, "exit-code.txt")),
    rawReport.report !== undefined,
    readText(path.join(artifactDirectory, "stderr.txt")),
  );
  if (facts.cliFailureKind !== rawFailureKind) {
    return "The artifact CLI failure kind does not match its raw report, exit code, and stderr.";
  }
  return undefined;
}

function infrastructureCell(expected, actionCommit, runUrl, reason) {
  return {
    engineRef: expected.engine_ref,
    packRef: expected.pack_ref,
    actionCommit,
    runUrl,
    classification: "infrastructure",
    reason,
    evidence: runUrl,
    facts: null,
  };
}

function loadExpectations(value) {
  if (!Array.isArray(value)) throw new Error("The compatibility expectations file must contain a JSON array.");
  for (const [index, expectation] of value.entries()) {
    if (
      !isObject(expectation) ||
      !nonEmptyString(expectation.engineRef) ||
      !nonEmptyString(expectation.packRef) ||
      !["fail", "error", "execution-failed"].includes(expectation.expectedStatus) ||
      !nonEmptyString(expectation.failureSignature) ||
      !nonEmptyString(expectation.runUrl) ||
      !nonEmptyString(expectation.dateAdded) ||
      !nonEmptyString(expectation.reason)
    ) {
      throw new Error(`The compatibility expectations entry at index ${index} is malformed.`);
    }
  }
  return value;
}

export function collectResults({
  matrixJson,
  prepareResult,
  matrixResult,
  artifactRoot,
  expectations = [],
  actionCommit = "",
  runUrl = "",
  executionMode = "",
}) {
  const issues = [];
  const cells = [];
  let matrix = [];

  if (prepareResult !== "success") {
    issues.push(workflowIssue("prepare", `Matrix preparation ended with ${prepareResult}.`, actionCommit, runUrl));
  }
  if (executionMode !== "offline-xdr") {
    issues.push(workflowIssue("execution-mode", "The workflow did not declare the offline-xdr execution mode.", actionCommit, runUrl));
  }

  try {
    matrix = readMatrix(matrixJson);
  } catch (error) {
    issues.push(workflowIssue("matrix-input", error instanceof Error ? error.message : String(error), actionCommit, runUrl));
  }

  let checkedExpectations;
  try {
    checkedExpectations = loadExpectations(expectations);
  } catch (error) {
    checkedExpectations = [];
    issues.push(workflowIssue("expectations", error instanceof Error ? error.message : String(error), actionCommit, runUrl));
  }

  if (matrixResult !== "success" && !(prepareResult !== "success" && matrixResult === "skipped")) {
    issues.push(workflowIssue("matrix-job", `The matrix job ended with ${matrixResult}.`, actionCommit, runUrl));
  }

  const expectedDirectories = new Set();
  for (const expected of matrix) {
    const directoryName = `cell-facts-${expected.cell_id}`;
    expectedDirectories.add(directoryName);
    const factsPath = path.join(artifactRoot ?? "", directoryName, "cell-facts.json");
    let raw;
    try {
      raw = readFileSync(factsPath, "utf8");
    } catch {
      cells.push(infrastructureCell(expected, actionCommit, runUrl, "The matrix cell artifact or cell-facts.json is missing."));
      continue;
    }

    let facts;
    try {
      facts = JSON.parse(raw);
    } catch (error) {
      cells.push(infrastructureCell(
        expected,
        actionCommit,
        runUrl,
        `The matrix cell facts are malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      ));
      continue;
    }

    const factsError = validateCellFacts(facts, expected, actionCommit, path.dirname(factsPath));
    if (factsError) {
      cells.push(infrastructureCell(expected, actionCommit, runUrl, factsError));
      continue;
    }

    cells.push({ ...classifyCell(facts, checkedExpectations), facts });
  }

  if (artifactRoot) {
    try {
      for (const entry of readdirSync(artifactRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("cell-facts-") && !expectedDirectories.has(entry.name)) {
          issues.push(workflowIssue("unexpected-artifact", `Unexpected cell artifact directory ${entry.name}.`, actionCommit, runUrl));
        }
      }
    } catch {
      if (matrix.length > 0) {
        issues.push(workflowIssue("artifact-download", "The downloaded cell artifact directory is missing or unreadable.", actionCommit, runUrl));
      }
    }
  } else if (matrix.length > 0) {
    issues.push(workflowIssue("artifact-download", "The downloaded cell artifact directory was not provided.", actionCommit, runUrl));
  }

  const hasFailures = issues.length > 0 || cells.some((cell) => shouldFailJob(cell.classification));
  return {
    schemaVersion: 1,
    actionCommit,
    runUrl,
    executionMode,
    expectedCellCount: matrix.length,
    cells,
    issues,
    hasFailures,
    table: formatResultsTable([
      ...cells,
      ...issues.map((issue) => ({
        engineRef: "workflow",
        packRef: issue.type,
        actionCommit: issue.actionCommit,
        runUrl: issue.runUrl,
        classification: "infrastructure",
        reason: issue.reason,
        evidence: issue.runUrl,
      })),
    ]),
  };
}

export function writeCollectionOutputs(report, outputPath) {
  if (!nonEmptyString(outputPath)) throw new Error("GITHUB_OUTPUT is required to publish compatibility results");
  let delimiter = `COMPAT_${randomUUID().replaceAll("-", "")}`;
  while (report.table.includes(delimiter)) delimiter = `COMPAT_${randomUUID().replaceAll("-", "")}`;
  appendFileSync(outputPath, `TABLE<<${delimiter}\n${report.table}\n${delimiter}\nHAS_FAILURES=${String(report.hasFailures)}\n`, "utf8");
}

function readExpectationsFile(filePath) {
  try {
    return loadExpectations(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    throw new Error(`Could not read compatibility expectations: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runCellCli() {
  const evidenceDir = process.env.EVIDENCE_DIR;
  const facts = writeCellFacts({ env: process.env, evidenceDir });
  console.log(`Wrote cell facts for ${facts.cellId || "an unidentified cell"}.`);
}

function runCollectCli() {
  let expectations = [];
  let expectationsError;
  try {
    expectations = readExpectationsFile("docs/compat-expectations.json");
  } catch (error) {
    expectationsError = error instanceof Error ? error.message : String(error);
  }

  let report = collectResults({
    matrixJson: process.env.MATRIX_JSON ?? "",
    prepareResult: process.env.PREPARE_RESULT ?? "unknown",
    matrixResult: process.env.MATRIX_RESULT ?? "unknown",
    artifactRoot: process.env.ARTIFACT_ROOT ?? "",
    expectations,
    actionCommit: process.env.ACTION_COMMIT ?? "",
    runUrl: process.env.RUN_URL ?? "",
    executionMode: process.env.EXECUTION_MODE ?? "",
  });
  if (expectationsError) {
    report.issues.push(workflowIssue("expectations", expectationsError, report.actionCommit, report.runUrl));
    report.hasFailures = true;
    report.table = formatResultsTable([
      ...report.cells,
      ...report.issues.map((issue) => ({
        engineRef: "workflow",
        packRef: issue.type,
        actionCommit: issue.actionCommit,
        runUrl: issue.runUrl,
        classification: "infrastructure",
        reason: issue.reason,
        evidence: issue.runUrl,
      })),
    ]);
  }

  writeFileSync("compat-matrix.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeCollectionOutputs(report, process.env.GITHUB_OUTPUT);
  console.log(`Classified ${report.cells.length} of ${report.expectedCellCount} expected compatibility cells.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "cell") runCellCli();
    else if (process.argv[2] === "collect") runCollectCli();
    else throw new Error("Expected 'cell' or 'collect' mode.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
