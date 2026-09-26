// Tests for the `notablyList` behaviour behind the summary's Failures/Warnings
// sections: every line of a multi-line `details` string must be indented under
// its bullet (and surrounding blank lines trimmed), so the rendered Markdown
// keeps the details attached to the right test.
import { describe, expect, it } from "vitest";

import { renderSummaryMarkdown } from "../../src/summary";
import { report, result } from "./helpers";

describe("notablyList indentation", () => {
  it("indents every line of a multi-line detail string under its bullet", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({
            testId: "p28-xdr-cap83-002",
            surface: "xdr",
            status: "fail",
            summary: "compatibility assertion failed",
            details: "byte 12 differs\nexpected 0x00\ngot 0x01",
            fixtureId: "p28-xdr-cap83-002",
          }),
        ],
      }),
    );

    expect(markdown).toContain(
      "- `p28-xdr-cap83-002` (xdr) — compatibility assertion failed\n" +
        "  byte 12 differs\n" +
        "  expected 0x00\n" +
        "  got 0x01",
    );
  });

  it("trims surrounding blank lines before indenting the details", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "error",
        counts: { total: 1, passed: 0, failed: 0, warnings: 0, errors: 1, skipped: 0 },
        results: [
          result({
            testId: "p28-rpc-001",
            surface: "rpc",
            status: "error",
            summary: "execution failed",
            details: "\n  first line\nsecond line  \n\n",
            fixtureId: "p28-rpc-001",
          }),
        ],
      }),
    );

    // Every line of the detail block is indented (not just the first), and
    // the blank lines around it are gone.
    expect(markdown).toContain(
      "- `p28-rpc-001` (rpc) — execution failed\n  first line\n  second line",
    );
    expect(markdown).not.toContain("\n\n  first line");
  });

  it("renders a bullet with no detail lines when details are missing or blank", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        counts: { total: 2, passed: 0, failed: 2, warnings: 0, errors: 0, skipped: 0 },
        results: [
          result({ testId: "a", surface: "xdr", status: "fail", summary: "no details here" }),
          result({
            testId: "b",
            surface: "xdr",
            status: "fail",
            summary: "blank details",
            details: "   ",
          }),
        ],
      }),
    );

    expect(markdown).toContain("- `a` (xdr) — no details here\n");
    expect(markdown).toContain("- `b` (xdr) — blank details\n");
  });
});
