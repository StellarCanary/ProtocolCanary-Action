import * as core from "@actions/core";

import { SummaryPublishFailedError } from "./errors";
import { CanaryReport, OverallStatus, Surface } from "./output";

const SURFACE_HEADINGS: Readonly<Record<Surface, string>> = {
  xdr: "XDR",
  rpc: "RPC",
  soroban: "Soroban",
};

const SURFACE_ORDER: readonly Surface[] = ["xdr", "rpc", "soroban"];

const OVERALL_LABEL: Readonly<Record<OverallStatus, string>> = {
  pass: "✅ **PASS**",
  warning: "⚠️ **WARNING**",
  fail: "❌ **NOT READY**",
  error: "🚫 **ERROR**",
};

function surfaceRowLabel(results: CanaryReport["results"], surface: Surface): string | undefined {
  const forSurface = results.filter((r) => r.surface === surface);
  if (forSurface.length === 0) {
    return undefined;
  }
  const worst = forSurface.some((r) => r.status === "fail" || r.status === "error")
    ? "fail"
    : forSurface.some((r) => r.status === "warning")
      ? "warning"
      : "pass";
  const passCount = forSurface.filter((r) => r.status === "pass").length;
  const icon = worst === "fail" ? "❌ FAIL" : worst === "warning" ? "⚠️ WARNING" : "✅ PASS";
  return `| ${SURFACE_HEADINGS[surface]} | ${icon} (${String(passCount)}/${String(forSurface.length)}) |`;
}

function notablyList(report: CanaryReport, statuses: readonly ("fail" | "error" | "warning")[]): string[] {
  return report.results
    .filter((r) => (statuses as readonly string[]).includes(r.status))
    .map((r) => {
      const lines = [`- \`${r.testId}\` (${r.surface}) — ${r.summary}`];
      if (r.details !== undefined && r.details.trim() !== "") {
        lines.push(
          r.details
            .trim()
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n"),
        );
      }
      return lines.join("\n");
    });
}

/** Pure Markdown rendering, kept separate from `core.summary` so it can be
 * golden/snapshot-tested without a GitHub Actions runtime. */
export function renderSummaryMarkdown(report: CanaryReport): string {
  const lines: string[] = [];
  lines.push("## Stellar Protocol Canary", "");
  lines.push(`Protocol: ${String(report.targetProtocol)}`);
  lines.push(`Project: ${report.project.name} (${report.project.type})`);
  if (report.network !== undefined) {
    const observed =
      report.network.observedProtocol !== undefined ? ` — observed protocol ${String(report.network.observedProtocol)}` : "";
    lines.push(`Network: ${report.network.name}${observed}`);
  }
  lines.push(`Canary version: ${report.toolVersion}`, "");

  const rows = SURFACE_ORDER.map((surface) => surfaceRowLabel(report.results, surface)).filter(
    (row): row is string => row !== undefined,
  );
  if (rows.length > 0) {
    lines.push("| Surface | Result |", "|---|---|", ...rows, "");
  }

  lines.push("### Result", "", OVERALL_LABEL[report.status], "");
  lines.push(`${String(report.counts.passed)}/${String(report.counts.total)} applicable checks passed.`, "");

  const failures = notablyList(report, ["fail", "error"]);
  if (failures.length > 0) {
    lines.push("#### Failures", "", ...failures, "");
  }

  const warnings = notablyList(report, ["warning"]);
  if (warnings.length > 0) {
    lines.push("#### Warnings", "", ...warnings, "");
  }

  if (report.skipped !== undefined && report.skipped.length > 0) {
    lines.push(
      "<details><summary>Skipped fixtures</summary>",
      "",
      ...report.skipped.map((s) => `- \`${s.fixtureId}\` (${s.surface}) — ${s.reason}`),
      "",
      "</details>",
      "",
    );
  }

  return lines.join("\n");
}

export function renderExecutionFailureMarkdown(reason: string, diagnostic: string): string {
  return [
    "## Stellar Protocol Canary",
    "",
    "### Result",
    "",
    "🚫 **ERROR**",
    "",
    "Protocol Canary could not be executed.",
    "",
    `Reason: ${reason}`,
    "",
    "```text",
    diagnostic.trim() === "" ? "(no diagnostic output)" : diagnostic.trim(),
    "```",
  ].join("\n");
}

export async function writeSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown, true).write();
  } catch (error) {
    throw new SummaryPublishFailedError(
      `Failed to publish Canary summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
