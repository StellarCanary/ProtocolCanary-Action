import * as core from "@actions/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { uploadReport } from "./artifact";
import { emitAnnotations, emitExecutionFailureAnnotation } from "./annotations";
import { ensureCanaryInstalled } from "./canary";
import { describeError, isCanaryActionError } from "./errors";
import { getInputs } from "./inputs";
import { describeExitCode, parseReport } from "./output";
import { buildCheckArgs, runCheck } from "./runner";
import { renderExecutionFailureMarkdown, renderSummaryMarkdown, writeSummary } from "./summary";
import { resolveVersion } from "./version";

function reportFilePath(): string {
  const dir = process.env.RUNNER_TEMP ?? os.tmpdir();
  return path.join(dir, "stellar-canary-report.json");
}

/** Handles every case where Canary did not produce a usable report at all
 * (install failure, process error, timeout, or malformed JSON) —
 * distinct from a real compatibility failure per section 29. */
async function handleExecutionFailure(reason: string, diagnostic: string, annotate: boolean): Promise<void> {
  core.setFailed(`Protocol Canary could not be executed.\n\nReason:\n${reason}`);
  if (annotate) {
    emitExecutionFailureAnnotation(reason);
  }
  try {
    await writeSummary(renderExecutionFailureMarkdown(reason, diagnostic));
  } catch (error) {
    core.setFailed(describeError(error));
  }
  core.setOutput("status", "execution-failed");
  core.setOutput("passed", "0");
  core.setOutput("warnings", "0");
  core.setOutput("failures", "0");
  core.setOutput("errors", "0");
}

export async function run(): Promise<void> {
  let inputs;
  try {
    inputs = getInputs();
  } catch (error) {
    core.setFailed(describeError(error));
    return;
  }

  const resolved = await resolveVersion(inputs.version);
  core.info(
    `Stellar Protocol Canary Action\nCanary version: ${resolved.version} (${resolved.tag}${
      resolved.commitSha !== undefined ? `@${resolved.commitSha.slice(0, 12)}` : ""
    })`,
  );

  let installed;
  try {
    installed = await ensureCanaryInstalled(resolved);
  } catch (error) {
    await handleExecutionFailure(describeError(error), "", inputs.annotations);
    return;
  }

  core.info(`Protocol: ${inputs.protocol !== undefined ? String(inputs.protocol) : "(from configuration)"}`);
  core.info("Running compatibility checks...");

  let execution;
  try {
    execution = await runCheck(installed.binaryPath, buildCheckArgs(inputs), inputs.timeoutMinutes * 60_000);
  } catch (error) {
    await handleExecutionFailure(describeError(error), "", inputs.annotations);
    return;
  }

  const reportPath = reportFilePath();
  if (execution.stdout.trim() !== "") {
    fs.writeFileSync(reportPath, execution.stdout, "utf8");
  }

  if (execution.exitCode === null) {
    await handleExecutionFailure(
      `Canary was terminated by signal ${execution.signal ?? "unknown"}.`,
      execution.stderr,
      inputs.annotations,
    );
    return;
  }

  const exitInfo = describeExitCode(execution.exitCode);

  let report;
  try {
    report = parseReport(execution.stdout);
  } catch (error) {
    await handleExecutionFailure(
      `${exitInfo.description} (exit code ${String(execution.exitCode)}). ${describeError(error)}`,
      execution.stderr,
      inputs.annotations,
    );
    return;
  }

  core.info(`${String(report.counts.passed)}/${String(report.counts.total)} applicable checks passed.`);
  core.info(`Status: ${report.status.toUpperCase()}`);

  if (inputs.annotations) {
    emitAnnotations(report);
  }

  try {
    await writeSummary(renderSummaryMarkdown(report));
  } catch (error) {
    core.setFailed(describeError(error));
  }

  core.setOutput("status", report.status);
  core.setOutput("passed", String(report.counts.passed));
  core.setOutput("warnings", String(report.counts.warnings));
  core.setOutput("failures", String(report.counts.failed));
  core.setOutput("errors", String(report.counts.errors));
  core.setOutput("report", reportPath);

  if (inputs.uploadReport) {
    await uploadReport(reportPath);
  }

  // Canary's own exit code is authoritative: never recompute pass/fail
  // from the parsed report.
  if (execution.exitCode !== 0) {
    core.setFailed(
      `Stellar Protocol Canary reported ${report.status} (${exitInfo.description}, exit code ${String(execution.exitCode)}).`,
    );
  }
}

/* istanbul ignore next -- exercised via the compiled entry point, not unit tests */
if (require.main === module) {
  run().catch((error: unknown) => {
    core.setFailed(isCanaryActionError(error) ? error.message : describeError(error));
  });
}
