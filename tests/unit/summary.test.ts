import { describe, expect, it } from "vitest";

import { renderExecutionFailureMarkdown, renderSummaryMarkdown } from "../../src/summary";
import { report, result } from "./helpers";

describe("renderSummaryMarkdown", () => {
  it("renders a passing report", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "pass",
        counts: { total: 3, passed: 3, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({ testId: "a", surface: "xdr", fixtureId: "a" }),
          result({ testId: "b", surface: "rpc", fixtureId: "b" }),
          result({ testId: "c", surface: "soroban", fixtureId: "c" }),
        ],
      }),
    );

    expect(markdown).toContain("## Stellar Protocol Canary");
    expect(markdown).toContain("Protocol: 28");
    expect(markdown).toContain("✅ **PASS**");
    expect(markdown).toContain("3/3 applicable checks passed.");
    expect(markdown).toContain("| XDR | ✅ PASS (1/1) |");
    expect(markdown).not.toContain("#### Failures");
  });

  it("renders a failing report with the failing test id and details", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({
            testId: "p28-xdr-cap83-001",
            surface: "xdr",
            status: "fail",
            summary: "could not satisfy the compatibility assertion",
            details: "byte 12 differs",
            fixtureId: "p28-xdr-cap83-001",
          }),
        ],
      }),
    );

    expect(markdown).toContain("❌ **NOT READY**");
    expect(markdown).toContain("#### Failures");
    expect(markdown).toContain("p28-xdr-cap83-001");
    expect(markdown).toContain("byte 12 differs");
    expect(markdown).toContain("| XDR | ❌ FAIL (0/1) |");
  });

  it("omits a surface row entirely when no results exist for it (offline run)", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "pass",
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [result({ testId: "a", surface: "xdr", fixtureId: "a" })],
      }),
    );
    expect(markdown).not.toContain("| RPC |");
    expect(markdown).not.toContain("| Soroban |");
  });

  it("lists skipped fixtures in a collapsible section when present", () => {
    const markdown = renderSummaryMarkdown(
      report({
        skipped: [{ fixtureId: "p27-xdr-legacy", surface: "xdr", reason: "fixture targets protocol 27, this run targets protocol 28" }],
      }),
    );
    expect(markdown).toContain("<details><summary>Skipped fixtures</summary>");
    expect(markdown).toContain("p27-xdr-legacy");
  });

  it("never fabricates a result: an empty results array renders as a trivial pass with no surface rows", () => {
    const markdown = renderSummaryMarkdown(report({ status: "pass" }));
    expect(markdown).not.toContain("| XDR |");
    expect(markdown).not.toContain("| RPC |");
    expect(markdown).not.toContain("| Soroban |");
    expect(markdown).toContain("0/0 applicable checks passed.");
  });
});

describe("renderExecutionFailureMarkdown", () => {
  it("clearly distinguishes an execution failure from a compatibility failure", () => {
    const markdown = renderExecutionFailureMarkdown("cargo install failed", "error: could not compile");
    expect(markdown).toContain("could not be executed");
    expect(markdown).not.toContain("NOT READY");
    expect(markdown).toContain("error: could not compile");
  });

  it("shows a placeholder when there is no diagnostic output", () => {
    const markdown = renderExecutionFailureMarkdown("timed out", "");
    expect(markdown).toContain("(no diagnostic output)");
  });
});
