import * as core from "@actions/core";

import { CanaryReport } from "./output";

const TITLE = "Stellar Protocol Canary";

/**
 * Converts fail/error/warning results into GitHub annotations. No fixture
 * in the documented report schema carries a file/line location, so every
 * annotation is a general workflow-level one (`core.error`/`core.warning`
 * with no `AnnotationProperties.file`) — never a fabricated location.
 * Passing and skipped results never produce an annotation: they are not
 * actionable.
 */
export function emitAnnotations(report: CanaryReport): void {
  for (const result of report.results) {
    const message = `[${result.surface}] ${result.testId}: ${result.summary}`;
    if (result.status === "fail" || result.status === "error") {
      core.error(message, { title: TITLE });
    } else if (result.status === "warning") {
      core.warning(message, { title: TITLE });
    }
  }
}

export function emitExecutionFailureAnnotation(reason: string): void {
  core.error(`Protocol Canary could not be executed: ${reason}`, { title: TITLE });
}
