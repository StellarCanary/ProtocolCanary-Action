// Tests for `run()`'s handling of a canary process that never finishes.
//
// Issue #181: when the child process exceeds its timeout, `runCheck` rejects
// with a `TimeoutError`; `run()` must treat that as an execution failure —
// `core.setFailed` with a message naming the reason, the `execution-failed`
// outputs, and no artifact upload, because there is no report to upload.
//
// Every module `run()` touches is mocked, so nothing here shells out, reads a
// cache, or talks to GitHub (same convention as canary.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  setFailedMock: vi.fn(),
  infoMock: vi.fn(),
  setOutputMock: vi.fn(),
  summaryMock: { addRaw: vi.fn(), write: vi.fn() },
}));

vi.mock("@actions/core", () => ({
  setFailed: coreMocks.setFailedMock,
  info: coreMocks.infoMock,
  setOutput: coreMocks.setOutputMock,
  summary: coreMocks.summaryMock,
}));

const mocks = vi.hoisted(() => ({
  getInputs: vi.fn(),
  resolveVersion: vi.fn(),
  ensureCanaryInstalled: vi.fn(),
  buildCheckArgs: vi.fn(),
  runCheck: vi.fn(),
  writeSummary: vi.fn(),
  emitAnnotations: vi.fn(),
  emitExecutionFailureAnnotation: vi.fn(),
  uploadReport: vi.fn(),
  renderSummaryMarkdown: vi.fn(() => "summary markdown"),
  renderExecutionFailureMarkdown: vi.fn(() => "failure markdown"),
}));

vi.mock("../../src/inputs", () => ({ getInputs: mocks.getInputs }));
vi.mock("../../src/version", () => ({ resolveVersion: mocks.resolveVersion }));
vi.mock("../../src/canary", () => ({ ensureCanaryInstalled: mocks.ensureCanaryInstalled }));
vi.mock("../../src/runner", () => ({
  buildCheckArgs: mocks.buildCheckArgs,
  runCheck: mocks.runCheck,
}));
vi.mock("../../src/summary", () => ({
  writeSummary: mocks.writeSummary,
  renderSummaryMarkdown: mocks.renderSummaryMarkdown,
  renderExecutionFailureMarkdown: mocks.renderExecutionFailureMarkdown,
}));
vi.mock("../../src/annotations", () => ({
  emitAnnotations: mocks.emitAnnotations,
  emitExecutionFailureAnnotation: mocks.emitExecutionFailureAnnotation,
}));
vi.mock("../../src/artifact", () => ({ uploadReport: mocks.uploadReport }));

import { TimeoutError } from "../../src/errors";
import { run } from "../../src/main";

const inputs = {
  protocol: 28,
  config: undefined,
  network: "testnet",
  rpcUrl: undefined,
  fixturesDir: "fixtures",
  version: "0.1.1",
  uploadReport: true,
  annotations: false,
  timeoutMinutes: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getInputs.mockReturnValue(inputs);
  mocks.resolveVersion.mockResolvedValue({ version: "0.1.1", tag: "v0.1.1", commitSha: "abc123" });
  mocks.ensureCanaryInstalled.mockResolvedValue({ binaryPath: "/tmp/stellar-canary" });
  mocks.buildCheckArgs.mockReturnValue(["check", "--json"]);
  mocks.writeSummary.mockResolvedValue(undefined);
});

describe("run() timeout handling", () => {
  it("calls setFailed with the timeout reason when runCheck rejects with a TimeoutError", async () => {
    mocks.runCheck.mockRejectedValue(new TimeoutError("Canary timed out after 300000 ms and was killed."));

    await run();

    expect(coreMocks.setFailedMock).toHaveBeenCalledTimes(1);
    const mensaje = String(coreMocks.setFailedMock.mock.calls[0]?.[0] ?? "");
    expect(mensaje).toContain("could not be executed");
    expect(mensaje).toContain("Canary timed out after 300000 ms and was killed.");
  });

  it("publishes the execution-failure summary and zeroed outputs, and never uploads an artifact", async () => {
    mocks.runCheck.mockRejectedValue(new TimeoutError("Canary timed out after 300000 ms and was killed."));

    await run();

    expect(mocks.renderExecutionFailureMarkdown).toHaveBeenCalledWith(
      "Canary timed out after 300000 ms and was killed.",
      "",
    );
    expect(mocks.writeSummary).toHaveBeenCalledWith("failure markdown");
    expect(coreMocks.setOutputMock).toHaveBeenCalledWith("status", "execution-failed");
    expect(coreMocks.setOutputMock).toHaveBeenCalledWith("passed", "0");
    expect(coreMocks.setOutputMock).toHaveBeenCalledWith("errors", "0");
    // There is no report to upload, and the summary was not rendered from one.
    expect(mocks.uploadReport).not.toHaveBeenCalled();
    expect(mocks.renderSummaryMarkdown).not.toHaveBeenCalled();
    expect(mocks.emitAnnotations).not.toHaveBeenCalled();
  });

  it("passes the configured timeout in milliseconds to runCheck", async () => {
    mocks.runCheck.mockRejectedValue(new TimeoutError("Canary timed out."));

    await run();

    expect(mocks.runCheck).toHaveBeenCalledWith("/tmp/stellar-canary", ["check", "--json"], 300_000);
  });

  it("annotates the failure only when annotations are enabled", async () => {
    mocks.runCheck.mockRejectedValue(new TimeoutError("Canary timed out."));
    mocks.getInputs.mockReturnValue({ ...inputs, annotations: true });

    await run();

    expect(mocks.emitExecutionFailureAnnotation).toHaveBeenCalledWith("Canary timed out.");
  });
});
