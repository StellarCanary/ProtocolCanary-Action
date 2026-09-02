import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { setFailedMock, errorMock, warningMock } = vi.hoisted(() => ({
  setFailedMock: vi.fn(),
  errorMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return { ...actual, setFailed: setFailedMock, error: errorMock, warning: warningMock };
});

// Keep resolveVersion's GitHub API call out of the network entirely: it
// must degrade gracefully (see version.test.ts), and this suite only
// cares about what happens downstream of installation.
vi.mock("node:https", () => ({
  get: vi.fn((_url: string, _options: unknown, callback: (response: unknown) => void) => {
    const response = {
      statusCode: 500,
      setEncoding: () => undefined,
      resume: () => undefined,
      on: () => undefined,
    };
    queueMicrotask(() => callback(response));
    return { on: () => undefined, destroy: () => undefined };
  }),
}));

const MOCK_CANARY_SOURCE = path.join(__dirname, "..", "fixtures", "mock-canary.cjs");
const ENV_KEYS = [
  "CARGO_HOME",
  "RUNNER_TEMP",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "MOCK_CANARY_SCENARIO",
  "MOCK_CANARY_VERSION",
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_NETWORK",
  "INPUT_RPC-URL",
  "INPUT_FIXTURES-DIR",
  "INPUT_VERSION",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_TIMEOUT-MINUTES",
];

interface Fixture {
  readonly workDir: string;
  readonly outputPath: string;
  readonly summaryPath: string;
}

// @actions/core's `core.summary` is a process-wide singleton that resolves
// and caches GITHUB_STEP_SUMMARY from the environment on its *first* use
// and ignores later changes to that variable. A fresh path per test would
// silently be ignored after the first test (and, worse, throw ENOENT once
// that first test's directory is cleaned up) — so every test in this file
// shares one persistent summary file instead, truncated between tests.
const SUMMARY_PATH = path.join(os.tmpdir(), `canary-e2e-summary-${String(process.pid)}.md`);

function setUp(scenario: string): Fixture {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-e2e-"));
  const cargoHome = path.join(workDir, "cargo-home");
  fs.mkdirSync(path.join(cargoHome, "bin"), { recursive: true });
  fs.copyFileSync(MOCK_CANARY_SOURCE, path.join(cargoHome, "bin", "stellar-canary"));
  fs.chmodSync(path.join(cargoHome, "bin", "stellar-canary"), 0o755);

  const runnerTemp = path.join(workDir, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  const outputPath = path.join(workDir, "github-output");
  const summaryPath = SUMMARY_PATH;
  fs.writeFileSync(outputPath, "");
  fs.writeFileSync(summaryPath, "");

  for (const key of ENV_KEYS) delete process.env[key];
  process.env.CARGO_HOME = cargoHome;
  process.env.RUNNER_TEMP = runnerTemp;
  process.env.GITHUB_OUTPUT = outputPath;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  process.env.MOCK_CANARY_SCENARIO = scenario;
  process.env.MOCK_CANARY_VERSION = "0.1.0";
  process.env.INPUT_VERSION = "0.1.0";
  process.env.INPUT_PROTOCOL = "28";
  process.env["INPUT_FIXTURES-DIR"] = "fixtures";
  process.env["INPUT_UPLOAD-REPORT"] = "false";
  process.env["INPUT_ANNOTATIONS"] = "true";
  process.env["INPUT_TIMEOUT-MINUTES"] = "1";

  setFailedMock.mockClear();
  errorMock.mockClear();
  warningMock.mockClear();

  return { workDir, outputPath, summaryPath };
}

function readOutputs(outputPath: string): Record<string, string> {
  const content = fs.readFileSync(outputPath, "utf8");
  const outputs: Record<string, string> = {};
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(lines[i] ?? "");
    if (match) {
      const [, name, delimiter] = match;
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i] ?? "");
        i++;
      }
      outputs[name as string] = valueLines.join("\n");
    }
  }
  return outputs;
}

describe("Action end-to-end (via mock-canary)", () => {
  let fixture: Fixture;

  afterEach(() => {
    if (fixture) {
      fs.rmSync(fixture.workDir, { recursive: true, force: true });
    }
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    fs.rmSync(SUMMARY_PATH, { force: true });
  });

  it("pass: succeeds, sets outputs, and writes no annotations", async () => {
    fixture = setUp("pass");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("pass");
    expect(outputs.passed).toBe("1");
    expect(outputs.failures).toBe("0");
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("✅ **PASS**");
  });

  it("warning: does not fail the job (default policy), but does annotate", async () => {
    fixture = setUp("warning");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).not.toHaveBeenCalled();
    expect(warningMock).toHaveBeenCalledTimes(1);
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("warning");
    expect(outputs.warnings).toBe("1");
  });

  it("fail: fails the job and annotates the failing check", async () => {
    fixture = setUp("fail");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("fail");
    expect(errorMock).toHaveBeenCalledTimes(1);
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("fail");
    expect(outputs.failures).toBe("1");
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("NOT READY");
  });

  it("config-error: reported as an execution failure, not a compatibility failure", async () => {
    fixture = setUp("config-error");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("could not be executed");
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("execution-failed");
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain("could not be executed");
  });

  it("rpc-error: a per-fixture execution error still produces a real report", async () => {
    fixture = setUp("rpc-error");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    const outputs = readOutputs(fixture.outputPath);
    expect(outputs.status).toBe("error");
    expect(outputs.errors).toBe("1");
  });

  it("fixture-error: reported as an execution failure", async () => {
    fixture = setUp("fixture-error");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(readOutputs(fixture.outputPath).status).toBe("execution-failed");
  });

  it("internal-error: reported as an execution failure", async () => {
    fixture = setUp("internal-error");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(readOutputs(fixture.outputPath).status).toBe("execution-failed");
  });

  it("malformed-json: a zero exit code with unparseable stdout is still an execution failure", async () => {
    fixture = setUp("malformed-json");
    const { run } = await import("../../src/main");
    await run();

    expect(setFailedMock).toHaveBeenCalledTimes(1);
    expect(String(setFailedMock.mock.calls[0]?.[0])).toContain("could not be executed");
    expect(readOutputs(fixture.outputPath).status).toBe("execution-failed");
  });
});
