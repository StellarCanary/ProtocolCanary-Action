import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reportFilePath } from "../../src/main";

// RUNNER_TEMP is an environment variable of the runner, so it must be
// restored afterwards: on GitHub-hosted runners it is always set, and
// other tests (the end-to-end suite) rely on managing it themselves.
const ORIGINAL_RUNNER_TEMP = process.env.RUNNER_TEMP;

describe("reportFilePath", () => {
  beforeEach(() => {
    delete process.env.RUNNER_TEMP;
  });

  afterEach(() => {
    if (ORIGINAL_RUNNER_TEMP === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = ORIGINAL_RUNNER_TEMP;
    }
  });

  it("resolves under RUNNER_TEMP when it is set", () => {
    // Deliberately not os.tmpdir(): the sentinel must prove the path is
    // anchored to RUNNER_TEMP, not merely to some temporary directory.
    const runnerTemp = path.join(os.tmpdir(), "canary-report-file-path-sentinel");
    process.env.RUNNER_TEMP = runnerTemp;

    expect(reportFilePath()).toBe(path.join(runnerTemp, "stellar-canary-report.json"));
  });

  it("falls back to os.tmpdir() when RUNNER_TEMP is unset", () => {
    expect(reportFilePath()).toBe(path.join(os.tmpdir(), "stellar-canary-report.json"));
  });
});
