import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// #271 — covers two untested branches in main.ts's run():
//   1. execution.exitCode === null (process killed by signal)
//   2. writeSummary throws during the otherwise-successful path

// Mock @actions/core so we can assert setFailed / setOutput calls without
// leaking to the test runner's actual process state.
const setFailedMock = vi.fn();
const setOutputMock = vi.fn();
const infoMock = vi.fn();
vi.mock("@actions/core", () => ({
  setFailed: setFailedMock,
  setOutput: setOutputMock,
  info: infoMock,
  error: vi.fn(),
  warning: vi.fn(),
}));

// Mock inputs so getInputs returns a known fixture.
const { getInputsMock } = vi.hoisted(() => ({ getInputsMock: vi.fn() }));
vi.mock("../../src/inputs", () => ({
  getInputs: getInputsMock,
  // re-export the type for callers
}));

// Mock resolveVersion to skip the network/version resolution.
vi.mock("../../src/version", () => ({
  resolveVersion: vi.fn(async (v: unknown) => ({
    version: v,
    tag: `v${String(v)}`,
    commitSha: "abc123def456",
  })),
}));

// Mock ensureCanaryInstalled to return a path without touching the filesystem.
vi.mock("../../src/canary", () => ({
  ensureCanaryInstalled: vi.fn(async () => ({ binaryPath: "/usr/local/bin/canary" })),
}));

// Mock runCheck so we can drive each branch:
//   - signal kill: returns { stdout: "", stderr: "", exitCode: null, signal: "SIGTERM" }
//   - success: returns { stdout: JSON_REPORT, stderr: "", exitCode: 0, signal: null }
// Mock is hoisted so per-test setup can override its behavior.
const { runCheckMock } = vi.hoisted(() => ({ runCheckMock: vi.fn() }));
vi.mock("../../src/runner", () => ({
  buildCheckArgs: vi.fn(() => []),
  runCheck: runCheckMock,
}));

// Mock parseReport so the success path doesn't depend on the real canary output shape.
vi.mock("../../src/output", () => ({
  describeExitCode: vi.fn((code: number) => ({ code, description: `exit ${code}` })),
  parseReport: vi.fn(() => ({
    status: "passed",
    counts: { passed: 5, warnings: 0, failed: 0, errors: 0, total: 5 },
    entries: [],
  })),
}));

// Mock writeSummary so we can make it throw from the success branch.
const { writeSummaryMock } = vi.hoisted(() => ({ writeSummaryMock: vi.fn() }));
const { renderSummaryMarkdownMock } = vi.hoisted(() => ({ renderSummaryMarkdownMock: vi.fn() }));
const { renderExecutionFailureMarkdownMock } = vi.hoisted(() => ({ renderExecutionFailureMarkdownMock: vi.fn() }));
vi.mock("../../src/summary", () => ({
  renderSummaryMarkdown: renderSummaryMarkdownMock,
  renderExecutionFailureMarkdown: renderExecutionFailureMarkdownMock,
  writeSummary: writeSummaryMock,
}));

// Mock annotations module so it doesn't try to write to disk.
vi.mock("../../src/annotations", () => ({
  emitAnnotations: vi.fn(),
  emitExecutionFailureAnnotation: vi.fn(),
}));

// Mock the artifact uploader so we don't touch the network.
vi.mock("../../src/artifact", () => ({
  uploadReport: vi.fn(async () => {}),
}));

// Mock fs so we don't write the reportPath to the real /tmp.
vi.mock("node:fs", () => ({
  default: { writeFileSync: vi.fn(), existsSync: vi.fn(() => false), mkdirSync: vi.fn() },
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

import { run } from "../../src/main";
import { CanaryExecutionFailedError } from "../../src/errors";

const BASE_INPUTS = {
  protocol: 28,
  config: undefined,
  network: undefined,
  rpcUrl: undefined,
  fixturesDir: "fixtures",
  version: "0.1.0",
  uploadReport: false,
  annotations: true,
  timeoutMinutes: 15,
};

beforeEach(() => {
  getInputsMock.mockReturnValue(BASE_INPUTS);
  setFailedMock.mockClear();
  setOutputMock.mockClear();
  infoMock.mockClear();
  runCheckMock.mockReset();
  writeSummaryMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("run() — branch: execution.exitCode === null (signal kill)", () => {
  it("treats a signal-terminated process as an execution failure", async () => {
    runCheckMock.mockResolvedValue({
      stdout: "",
      stderr: "Killed",
      exitCode: null,
      signal: "SIGTERM" as const,
    });

    await run();

    // Should call setFailed on the execution-failure path
    expect(setFailedMock).toHaveBeenCalled();
    const failureMsg = setFailedMock.mock.calls[0][0] as string;
    expect(failureMsg).toContain("Protocol Canary could not be executed");
    // The status output should be 'execution-failed'
    const statusCall = setOutputMock.mock.calls.find((c) => c[0] === "status");
    expect(statusCall).toBeDefined();
    expect(statusCall![1]).toBe("execution-failed");
    // passed output should be "0"
    const passedCall = setOutputMock.mock.calls.find((c) => c[0] === "passed");
    expect(passedCall).toBeDefined();
    expect(passedCall![1]).toBe("0");
  });

  it("falls back to 'unknown' when signal is undefined on a null exit code", async () => {
    runCheckMock.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
    });

    await run();

    const failureMsg = setFailedMock.mock.calls[0][0] as string;
    expect(failureMsg).toContain("unknown");
  });
});

describe("run() — branch: writeSummary throws during the success path", () => {
  it("calls setFailed with the underlying error and does not crash", async () => {
    runCheckMock.mockResolvedValue({
      stdout: '{"status":"passed","counts":{"passed":5,"warnings":0,"failed":0,"errors":0,"total":5},"entries":[]}',
      stderr: "",
      exitCode: 0,
      signal: null,
    });
    // writeSummary throws during the otherwise-successful path
    const summaryError = new Error("GITHUB_STEP_SUMMARY not writable");
    writeSummaryMock.mockRejectedValue(summaryError);

    await run();

    // setFailed must be called with the writeSummary error
    expect(setFailedMock).toHaveBeenCalled();
    const failureMsg = setFailedMock.mock.calls[0][0] as string;
    expect(failureMsg).toContain("GITHUB_STEP_SUMMARY not writable");
  });

  it("still sets the status outputs when writeSummary throws", async () => {
    runCheckMock.mockResolvedValue({
      stdout: '{"status":"passed","counts":{"passed":5,"warnings":0,"failed":0,"errors":0,"total":5},"entries":[]}',
      stderr: "",
      exitCode: 0,
      signal: null,
    });
    writeSummaryMock.mockRejectedValue(new Error("disk full"));

    await run();

    // Even though writeSummary threw, the status outputs should still be set
    // (the catch handler in main.ts calls setFailed but the run continues
    // to setOutput status etc.)
    const statusCall = setOutputMock.mock.calls.find((c) => c[0] === "status");
    expect(statusCall).toBeDefined();
    expect(statusCall![1]).toBe("passed");
  });
});
