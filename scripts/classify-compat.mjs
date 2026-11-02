/**
 * Classification logic for compatibility matrix cells.
 *
 * This module is kept pure (no I/O, no GitHub Actions dependencies) so it can
 * be unit tested exhaustively. The workflow calls `classifyCell` for each
 * matrix cell and aggregates the results.
 */

/**
 * @typedef {Object} CellFacts
 * @property {number} schemaVersion - Version of the facts artifact contract.
 * @property {string} cellId - Unique identity from the prepared matrix.
 * @property {string} engineRef - The engine reference that was tested (e.g., "v0.1.1", "main").
 * @property {string} packRef - The fixture pack reference that was tested (e.g., "protocol-28", "main").
 * @property {string|null} engineCommit - Resolved Engine commit SHA from checkout.
 * @property {string|null} fixturesCommit - Resolved Fixtures commit SHA from checkout.
 * @property {string} actionCommit - The Action commit SHA that ran the test.
 * @property {string} runUrl - The GitHub Actions run URL for this cell.
 * @property {"success"|"failure"|"cancelled"|"skipped"} engineCheckoutOutcome - Engine checkout outcome.
 * @property {"success"|"failure"|"cancelled"|"skipped"} fixturesCheckoutOutcome - Fixtures checkout outcome.
 * @property {"success"|"failure"|"timeout"|"cancelled"|"skipped"} buildOutcome - Build outcome.
 * @property {"completed"|"failure"|"timeout"|"cancelled"|"skipped"|"unknown"} checkOutcome - CLI execution outcome.
 * @property {string|null} actionStatus - Status from the validated CLI JSON report.
 * @property {number|null} passed - The CLI report's passed count.
 * @property {number|null} failures - The CLI report's failed count.
 * @property {number|null} warnings - The CLI report's warning count.
 * @property {number|null} errors - The CLI report's error count.
 * @property {number|null} replayedCount - Results replayed from cache.
 * @property {number|null} total - Total checks from `counts.total`.
 * @property {string} [firstDiagnostic] - First line of diagnostic/stderr.
 * @property {boolean} ranNoChecks - Whether the run executed zero checks.
 * @property {string|null} evidenceError - Error that made the CLI report unusable, if any.
 * @property {string[]} evidenceFiles - Names of the raw execution files in the artifact.
 */

/**
 * @typedef {Object} ExpectationEntry
 * @property {string} engineRef - Engine reference this expectation applies to.
 * @property {string} packRef - Fixture pack reference this expectation applies to.
 * @property {"fail"|"error"|"execution-failed"} expectedStatus - Expected Action status.
 * @property {string} failureSignature - First line of diagnostic that identifies this failure.
 * @property {string} runUrl - URL of the run that produced this expectation (evidence).
 * @property {string} dateAdded - Date the expectation was added (ISO 8601).
 * @property {string} reason - Human-readable reason for the expected incompatibility.
 */

/**
 * @typedef {Object} ClassifiedCell
 * @property {string} engineRef
 * @property {string} packRef
 * @property {string} actionCommit
 * @property {string} runUrl
 * @property {string} classification - One of the CellClassification values.
 * @property {string} reason
 * @property {string} evidence
 */

/**
 * @typedef {"supported"|"expected-incompatible"|"infrastructure"|"skipped"|"unexpected-failure"|"unexpected-pass"} CellClassification
 */

/**
 * Classifies a single matrix cell based on its observed facts and the
 * expectations registry.
 *
 * @param {CellFacts} facts
 * @param {ExpectationEntry[]} expectations
 * @returns {ClassifiedCell}
 */
export function classifyCell(facts, expectations) {
  const infrastructure = (reason) => ({
    engineRef: facts.engineRef,
    packRef: facts.packRef,
    actionCommit: facts.actionCommit,
    runUrl: facts.runUrl,
    classification: "infrastructure",
    reason,
    evidence: facts.runUrl,
  });

  if (
    facts.schemaVersion !== 1 ||
    !facts.cellId ||
    !facts.engineRef ||
    !facts.packRef ||
    !facts.actionCommit ||
    !facts.runUrl ||
    typeof facts.ranNoChecks !== "boolean" ||
    !Array.isArray(facts.evidenceFiles) ||
    (facts.evidenceError !== null && typeof facts.evidenceError !== "string")
  ) {
    return infrastructure("Cell facts are missing required fields or have an unsupported schema.");
  }

  if (facts.engineCheckoutOutcome !== "success") {
    return infrastructure(`Engine checkout ${facts.engineCheckoutOutcome}: unable to evaluate compatibility`);
  }
  if (facts.fixturesCheckoutOutcome !== "success") {
    return infrastructure(`Fixtures checkout ${facts.fixturesCheckoutOutcome}: unable to evaluate compatibility`);
  }
  if (facts.buildOutcome !== "success") {
    return {
      ...infrastructure(`Build ${facts.buildOutcome}: unable to evaluate compatibility`),
    };
  }
  if (facts.checkOutcome === "timeout" || facts.checkOutcome === "cancelled") {
    return infrastructure(`Compatibility check ${facts.checkOutcome}: unable to evaluate compatibility`);
  }
  if (facts.evidenceError) {
    return infrastructure(
      `Execution evidence is incomplete: ${facts.evidenceError}${facts.firstDiagnostic ? `: ${facts.firstDiagnostic}` : ""}`,
    );
  }
  if (facts.checkOutcome !== "completed") {
    return infrastructure(`Compatibility check ${facts.checkOutcome}: unable to evaluate compatibility`);
  }

  for (const field of ["passed", "failures", "warnings", "errors", "total", "replayedCount"]) {
    if (!Number.isSafeInteger(facts[field]) || facts[field] < 0) {
      return infrastructure(`Cell facts have a missing or invalid ${field} count.`);
    }
  }
  if (!new Set(["pass", "warning", "fail", "error", "execution-failed"]).has(facts.actionStatus)) {
    return infrastructure("Cell facts have a missing or invalid CLI status.");
  }

  // A valid empty report is useful evidence of a skipped cell, never support.
  if (facts.ranNoChecks || facts.total === 0) {
    return {
      engineRef: facts.engineRef,
      packRef: facts.packRef,
      actionCommit: facts.actionCommit,
      runUrl: facts.runUrl,
      classification: "skipped",
      reason: "Cell ran but executed zero checks (no compatible fixtures or empty fixture set)",
      evidence: facts.runUrl,
    };
  }

  // 3. Action ran and produced a status
  const status = facts.actionStatus ?? "unknown";

  // 3a. Pass with at least one executed check
  if (status === "pass") {
    // Check if there's an expectation saying this should fail
    const expectation = expectations.find(
      (e) => e.engineRef === facts.engineRef && e.packRef === facts.packRef,
    );
    if (expectation) {
      return {
        engineRef: facts.engineRef,
        packRef: facts.packRef,
        actionCommit: facts.actionCommit,
        runUrl: facts.runUrl,
        classification: "unexpected-pass",
        reason: `Expected ${expectation.expectedStatus} (${expectation.reason}) but got pass`,
        evidence: `Expected: ${expectation.runUrl} | Actual: ${facts.runUrl}`,
      };
    }
    return {
      engineRef: facts.engineRef,
      packRef: facts.packRef,
      actionCommit: facts.actionCommit,
      runUrl: facts.runUrl,
      classification: "supported",
      reason: "Compatibility checks passed",
      evidence: facts.runUrl,
    };
  }

  // 3b. Failure statuses (fail, error, execution-failed, warning)
  // Check if there's a matching expectation
  const expectation = expectations.find(
    (e) =>
      e.engineRef === facts.engineRef &&
      e.packRef === facts.packRef &&
      e.expectedStatus === status &&
      (facts.firstDiagnostic ?? "").includes(e.failureSignature),
  );

  if (expectation) {
    return {
      engineRef: facts.engineRef,
      packRef: facts.packRef,
      actionCommit: facts.actionCommit,
      runUrl: facts.runUrl,
      classification: "expected-incompatible",
      reason: `Known incompatibility: ${expectation.reason}`,
      evidence: `Expectation from: ${expectation.runUrl} | This run: ${facts.runUrl}`,
    };
  }

  // 3c. Unexpected failure
  return {
    engineRef: facts.engineRef,
    packRef: facts.packRef,
    actionCommit: facts.actionCommit,
    runUrl: facts.runUrl,
    classification: "unexpected-failure",
    reason: `Action reported ${status}${facts.firstDiagnostic ? `: ${facts.firstDiagnostic}` : ""}`,
    evidence: facts.runUrl,
  };
}

/**
 * Determines if a cell should fail the overall matrix job.
 * Infrastructure failures and unexpected compatibility results fail the job.
 *
 * @param {CellClassification} classification
 * @returns {boolean}
 */
export function shouldFailJob(classification) {
  return (
    classification === "infrastructure" ||
    classification === "unexpected-failure" ||
    classification === "unexpected-pass"
  );
}

function escapeTableCell(value, maxLength = 512) {
  return String(value)
    .slice(0, maxLength)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, "<br>")
    .replace(/\r/g, " ");
}

/**
 * Generates a markdown table row for a classified cell.
 *
 * @param {ClassifiedCell} cell
 * @returns {string}
 */
export function formatCellRow(cell) {
  const statusIcon = {
    supported: "✅",
    "expected-incompatible": "⚠️",
    infrastructure: "🔧",
    skipped: "⏭️",
    "unexpected-failure": "❌",
    "unexpected-pass": "🔄",
  };
  const icon = statusIcon[cell.classification] ?? "❓";
  return `| ${escapeTableCell(cell.engineRef, 255)} | ${escapeTableCell(cell.packRef, 255)} | ${icon} ${escapeTableCell(cell.classification, 64)} | ${escapeTableCell(cell.reason)} | ${escapeTableCell(cell.evidence)} |`;
}

/**
 * Generates the full markdown table for all classified cells.
 *
 * @param {ClassifiedCell[]} cells
 * @returns {string}
 */
export function formatResultsTable(cells) {
  const header = "| Engine | Pack | Classification | Reason | Evidence |\n|---|---|---|---|---|";
  const rows = cells.map(formatCellRow).join("\n");
  return `${header}\n${rows}`;
}
