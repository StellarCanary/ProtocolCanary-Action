import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { reportFilePath } from "../../src/main";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reportFilePath", () => {
  it("resolves under RUNNER_TEMP when set", () => {
    vi.stubEnv("RUNNER_TEMP", path.join("tmp", "runner"));

    expect(reportFilePath()).toBe(path.join("tmp", "runner", "stellar-canary-report.json"));
  });

  it("falls back to os.tmpdir when RUNNER_TEMP is unset", () => {
    vi.stubEnv("RUNNER_TEMP", undefined);

    expect(reportFilePath()).toBe(path.join(os.tmpdir(), "stellar-canary-report.json"));
  });
});
