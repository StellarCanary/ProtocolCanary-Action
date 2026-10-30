import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/main";
import type { CanaryReport } from "../../src/output";
import { renderSummaryMarkdown } from "../../src/summary";

/*
 * Issue #434: engine-provided text (fixture ids, result summaries and
 * details, skip reasons, the project and network names) comes from the
 * repository under test, which for a pull request is not trusted. The Action
 * puts those strings through two surfaces with different failure modes, so
 * they are tested separately:
 *
 *   workflow-command layer — @actions/core turns them into `::`-prefixed
 *   workflow commands and command files. The question is whether a string can
 *   make the runner execute a command of its own (a forged `::error::`, an
 *   `::add-mask::`, an `::stop-commands::`, an injected heredoc key).
 *
 *   Markdown layer — renderSummaryMarkdown interpolates them into a table and
 *   sections. The question is whether the document's structure survives
 *   (rows, columns, headings, the verdict section) and whether link, image and
 *   HTML syntax stays literal.
 *
 * `tests/unit/annotations.test.ts` mocks @actions/core, so the real command
 * encoder is never exercised there. These tests use the real module, capture
 * what it writes to stdout, and read the real GITHUB_OUTPUT file.
 *
 * Every case lives in tests/fixtures/hostile-strings.json with a name, the
 * value, the layer and a status. `enforced` cases pass today and are asserted
 * strictly. A case that fails today would be recorded as `pending-fix` with
 * its observed output, exercised but not asserted as passing, and listed in a
 * reviewed constant below so entries cannot be added or dropped silently. A
 * case that actually executed a command or injected an output line would not
 * be committed at all: it is a security finding and follows SECURITY.md.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOSTILE_MOCK = path.join(REPO_ROOT, "tests", "fixtures", "mock-canary-hostile.cjs");
const CASES_PATH = path.join(REPO_ROOT, "tests", "fixtures", "hostile-strings.json");
const ENGINE_VERSION = "0.1.0";

interface HostileCase {
  readonly name: string;
  /** The hostile string, placed in every engine-provided field by the mock. */
  readonly value: string;
  readonly layer: "workflow-command" | "markdown";
  readonly status: "enforced" | "pending-fix";
  /** Reviewed observation of a `pending-fix` case; absent when enforced. */
  readonly observed?: string;
}

const CASES: readonly HostileCase[] = (
  JSON.parse(fs.readFileSync(CASES_PATH, "utf8")) as { cases: HostileCase[] }
).cases;

/**
 * The pending-fix entries a reviewer has seen and approved. Kept next to the
 * tests (not only in the data file) so removing a case from the file or
 * changing its status fails visibly: the two lists must match exactly, in
 * order.
 */
const REVIEWED_PENDING_FIX_CASES: readonly string[] = [
  "table-pipe-and-backticks",
  "triple-backtick-fence",
];

/**
 * Workflow commands this Action emits for a failing report: progress lines
 * (`core.info`), per-result annotations and the engine-exit annotation
 * (`core.error`/`core.warning`), and the `core.debug` breadcrumbs that
 * @actions/core v3 writes unconditionally (the runner only displays them when
 * debug logging is on). Anything else on stdout means some string reached the
 * command layer as its own command.
 */
const ACTION_COMMANDS: readonly string[] = ["debug", "error", "info", "warning"];

/**
 * The exact set of keys the Action writes for a completed run with a report.
 * No engine-provided text is an output value today (the outputs are counts,
 * status literals, the resolved engine version and file paths), so a hostile
 * value can never become a key; this asserts that stays true.
 */
const EXPECTED_OUTPUT_KEYS: readonly string[] = [
  "artifact-id",
  "artifact-name",
  "coverage-state",
  "engine-version",
  "errors",
  "failures",
  "observed-protocol",
  "pack-digest",
  "pack-protocol",
  "pack-version",
  "passed",
  "replayed-count",
  "report",
  "skipped",
  "status",
  "total",
  "warnings",
];

/**
 * Variables inherited from the CI job that would let the child of this process
 * (the engine) or the Action itself reach a real service. Removed so every
 * run is hermetic.
 */
const HERMETIC_ENV_KEYS: readonly string[] = [
  "CARGO_HOME",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_ENV",
  "GITHUB_EVENT_PATH",
  "GITHUB_TOKEN",
  "HOSTILE_CASE",
  "NODE_OPTIONS",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
];

// Core's `summary` singleton resolves GITHUB_STEP_SUMMARY once, on its first
// write, and ignores later changes to the variable (see end-to-end.test.ts).
// Every run in this file therefore shares one summary file, truncated before
// each run.
const SUMMARY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "canary-hostile-summary-"));
const SUMMARY_PATH = path.join(SUMMARY_DIR, "github-step-summary");

// Resolve-version and the install chain must not reach the network: a 404 is
// a final answer (only 5xx/403/429 are retried), so these lookups degrade to
// tag-only pinning immediately instead of sleeping through retry backoff.
vi.mock("node:https", () => ({
  get: vi.fn((_url: string, _options: unknown, callback: (response: unknown) => void) => {
    const response = {
      statusCode: 404,
      setEncoding: () => undefined,
      resume: () => undefined,
      on: () => undefined,
    };
    queueMicrotask(() => callback(response));
    return { on: () => undefined, destroy: () => undefined };
  }),
}));

interface RunSetup {
  readonly workDir: string;
  readonly outputPath: string;
}

/**
 * Builds the runner-like environment for one in-process `run()`: temporary
 * `RUNNER_TEMP`/`CARGO_HOME`/`HOME`/`GITHUB_OUTPUT`/`GITHUB_STEP_SUMMARY`,
 * the hostile engine installed where the Action looks for one (with the
 * install-time digest #433 requires), and `HOSTILE_CASE` forwarded to the
 * engine through the same allow-list opt-in a workflow uses.
 */
function prepareRun(caseName: string): RunSetup {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-hostile-"));
  const runnerTemp = path.join(workDir, "runner-temp");
  const binaryDir = path.join(runnerTemp, "stellar-canary-action", "bin");
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.mkdirSync(path.join(workDir, "cargo-home", "bin"), { recursive: true });
  fs.mkdirSync(path.join(workDir, "home"), { recursive: true });
  const fixturesDir = path.join(workDir, "fixtures");
  fs.mkdirSync(fixturesDir);

  const enginePath = path.join(binaryDir, "stellar-canary");
  fs.copyFileSync(HOSTILE_MOCK, enginePath);
  fs.chmodSync(enginePath, 0o755);
  // The mock reads its cases from next to itself.
  fs.copyFileSync(CASES_PATH, path.join(binaryDir, "hostile-strings.json"));
  const digest = crypto.createHash("sha256").update(fs.readFileSync(enginePath)).digest("hex");
  fs.writeFileSync(path.join(binaryDir, "stellar-canary.sha256"), `${digest}\n`, { mode: 0o600 });

  const outputPath = path.join(workDir, "github-output");
  fs.writeFileSync(outputPath, "");
  fs.writeFileSync(path.join(workDir, "github-env"), "");
  fs.writeFileSync(SUMMARY_PATH, "");

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_")) {
      delete process.env[key];
    }
  }
  for (const key of HERMETIC_ENV_KEYS) {
    delete process.env[key];
  }

  process.env.CARGO_HOME = path.join(workDir, "cargo-home");
  process.env.HOME = path.join(workDir, "home");
  process.env.RUNNER_TEMP = runnerTemp;
  process.env.GITHUB_OUTPUT = outputPath;
  process.env.GITHUB_STEP_SUMMARY = SUMMARY_PATH;
  process.env.GITHUB_ENV = path.join(workDir, "github-env");
  process.env.HOSTILE_CASE = caseName;
  process.env.INPUT_VERSION = ENGINE_VERSION;
  process.env.INPUT_PROTOCOL = "28";
  process.env["INPUT_FIXTURES-DIR"] = fixturesDir;
  process.env["INPUT_UPLOAD-REPORT"] = "false";
  process.env.INPUT_ANNOTATIONS = "true";
  process.env["INPUT_TIMEOUT-MINUTES"] = "1";
  // The sentinel `action.yml` declares as this input's default (see inputs.ts).
  process.env["INPUT_NETWORK-PASSPHRASE"] = "\u0001";
  // #433: the engine receives an allow-listed environment, so the hostile
  // selection variable has to be forwarded the way a workflow would.
  process.env["INPUT_ENGINE-ENV-PASSTHROUGH"] = "HOSTILE_CASE";

  return { workDir, outputPath };
}

/** Runs the real Action in-process and captures everything @actions/core
 * writes to stdout, without mocking the module itself. */
async function captureRun(caseName: string): Promise<{
  lines: readonly string[];
  outputs: Record<string, string>;
  workDir: string;
}> {
  const setup = prepareRun(caseName);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return {
    lines: chunks.join("").split(/\r?\n/).filter((line) => line !== ""),
    outputs: readOutputs(setup.outputPath),
    workDir: setup.workDir,
  };
}

/** Reads the heredoc-format `GITHUB_OUTPUT` file the Action wrote. */
function readOutputs(outputPath: string): Record<string, string> {
  const content = fs.readFileSync(outputPath, "utf8");
  const outputs: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)<<(.+)$/.exec(lines[i] ?? "");
    if (match === null) {
      continue;
    }
    const [, name, delimiter] = match;
    const valueLines: string[] = [];
    i++;
    while (i < lines.length && lines[i] !== delimiter) {
      valueLines.push(lines[i] ?? "");
      i++;
    }
    outputs[name as string] = valueLines.join("\n");
  }
  return outputs;
}

/** The workflow command a captured stdout line names, e.g. "error". */
function commandName(line: string): string | undefined {
  return /^::([A-Za-z][A-Za-z0-9-]*)/.exec(line)?.[1];
}

/**
 * Runs the hostile fixture engine exactly as the Action invokes it and
 * returns the report it printed. Exits 1 by design (a compatibility failure).
 */
function hostileReport(caseName: string): CanaryReport {
  const result = spawnSync(process.execPath, [HOSTILE_MOCK, "check", "--format", "json"], {
    env: { ...process.env, HOSTILE_CASE: caseName },
    encoding: "utf8",
  });
  expect(result.status, `hostile mock stderr: ${result.stderr}`).toBe(1);
  return JSON.parse(result.stdout) as CanaryReport;
}

/**
 * Structural facts about a rendered summary. The values are compared against
 * the reviewed observation for a `pending-fix` case, so a Markdown finding is
 * pinned to exact observable output rather than silently tolerated.
 */
interface MarkdownObservation {
  /** Cell count of every row of every table, in document order. */
  readonly tables: readonly (readonly number[])[];
  /** How many times the `### Result` verdict heading occurs. */
  readonly verdicts: number;
  /** Every ATX heading line in the document, in order. */
  readonly headings: readonly string[];
  /** Bullet items under `#### Failures`. */
  readonly failureBullets: number;
}

/** Cells in a GFM table row: unescaped `|` separators, minus one. */
function cellCount(line: string): number {
  return line.split(/(?<!\\)\|/).length - 2;
}

/**
 * Splits a rendered document into the lines that are ordinary Markdown
 * (`prose`) and everything inside fenced code blocks. Fence content is
 * literal by design — engine text there is displayed, not interpreted — so
 * structure and syntax checks must not read it as document markup.
 */
function splitDocument(markdown: string): { readonly prose: readonly string[] } {
  const prose: string[] = [];
  let fenceLength = 0;
  for (const line of markdown.split("\n")) {
    const fence = /^(`{3,})/.exec(line);
    if (fenceLength === 0) {
      if (fence !== null) {
        fenceLength = (fence[1] as string).length;
        continue;
      }
      prose.push(line);
      continue;
    }
    if (fence !== null && (fence[1] as string).length >= fenceLength) {
      fenceLength = 0;
    }
  }
  return { prose };
}

function observeMarkdown(report: CanaryReport): MarkdownObservation {
  const { prose } = splitDocument(renderSummaryMarkdown(report));
  const tables: number[][] = [];
  let current: number[] | undefined;
  for (const line of prose) {
    if (line.startsWith("|")) {
      current = current ?? [];
      current.push(cellCount(line));
    } else if (current !== undefined) {
      tables.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) {
    tables.push(current);
  }

  const failureIndex = prose.indexOf("#### Failures");
  let failureBullets = 0;
  if (failureIndex !== -1) {
    for (const line of prose.slice(failureIndex + 1)) {
      if (line.startsWith("#") || line.startsWith("<details>")) {
        break;
      }
      if (line.startsWith("- ")) {
        failureBullets++;
      }
    }
  }

  return {
    tables,
    verdicts: prose.filter((line) => line === "### Result").length,
    headings: prose.filter((line) => /^#{1,6} /.test(line)),
    failureBullets,
  };
}

/** Compact, stable rendering used for a reviewed `pending-fix` observation. */
function serializeObservation(observation: MarkdownObservation): string {
  return JSON.stringify(observation);
}

/** Headings `renderSummaryMarkdown` itself writes; a hostile value must not
 * add another one. */
const SUMMARY_HEADINGS: readonly string[] = [
  "## Stellar Protocol Canary",
  "### Result",
  "#### Failures",
];

/*
 * The workflow-command layer runs the hostile engine as a real child process
 * through the Action's spawn chain, and the engine here is a shebang script:
 * on Windows the Action resolves `stellar-canary.exe`, and a JavaScript file
 * under that name is not a valid Win32 executable. Issue #436 tracks the
 * Node-copy engine that will supply `.exe` support; until then this layer is
 * skipped there for the same reason `tests/integration/end-to-end.test.ts` is.
 * The Markdown layer is pure string rendering and still runs on all three
 * platforms, so the escaping assertions are not lost on Windows.
 */
const SKIP_WORKFLOW_LAYER = process.platform === "win32";

const WORKFLOW_CASES = CASES.filter((testCase) => testCase.layer === "workflow-command");
const MARKDOWN_CASES = CASES.filter((testCase) => testCase.layer === "markdown");
const ENFORCED_WORKFLOW_CASES = WORKFLOW_CASES.filter((testCase) => testCase.status === "enforced");
const ENFORCED_MARKDOWN_CASES = MARKDOWN_CASES.filter((testCase) => testCase.status === "enforced");
const PENDING_FIX_CASES = CASES.filter((testCase) => testCase.status === "pending-fix");

afterAll(() => {
  fs.rmSync(SUMMARY_DIR, { recursive: true, force: true });
});

describe("hostile report strings (data file)", () => {
  it("holds at least 12 uniquely named cases covering both layers", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(CASES.map((testCase) => testCase.name)).size).toBe(CASES.length);
    expect(WORKFLOW_CASES.length).toBeGreaterThan(0);
    expect(MARKDOWN_CASES.length).toBeGreaterThan(0);
    for (const testCase of CASES) {
      expect(testCase.value, `${testCase.name} has an empty value`).not.toBe("");
      expect(["workflow-command", "markdown"]).toContain(testCase.layer);
      expect(["enforced", "pending-fix"]).toContain(testCase.status);
    }
  });

  // A workflow-command case that fails today executes a command or injects an
  // output line: that is a security finding, handled through SECURITY.md and
  // deliberately absent from this public data file. Only Markdown rendering
  // gaps may wait as reviewed pending-fix entries.
  it("keeps pending-fix entries to the Markdown layer and records their observation", () => {
    for (const testCase of PENDING_FIX_CASES) {
      expect(testCase.layer, `${testCase.name} must not publish a workflow-command finding`).toBe("markdown");
      expect(testCase.observed, `${testCase.name} needs a recorded observation`).toBeTruthy();
    }
    for (const testCase of CASES.filter((entry) => entry.status === "enforced")) {
      expect(testCase.observed, `${testCase.name} is enforced and needs no observation`).toBeUndefined();
    }
  });

  it("matches the reviewed pending-fix list exactly", () => {
    expect(PENDING_FIX_CASES.map((testCase) => testCase.name)).toEqual([...REVIEWED_PENDING_FIX_CASES]);
  });
});

describe.skipIf(SKIP_WORKFLOW_LAYER)("workflow-command layer (real @actions/core)", () => {
  afterEach(() => {
    for (const key of HERMETIC_ENV_KEYS) {
      delete process.env[key];
    }
  });

  for (const testCase of ENFORCED_WORKFLOW_CASES) {
    it(`${testCase.name}: stays inside the Action's own workflow commands`, async () => {
      const result = await captureRun(testCase.name);
      try {
        const commandLines = result.lines.filter((line) => line.startsWith("::"));
        expect(
          commandLines.length,
          "the Action emitted no workflow command, so nothing about the encoder was exercised",
        ).toBeGreaterThan(0);

        for (const line of commandLines) {
          expect(
            [...ACTION_COMMANDS],
            `unexpected workflow command ${JSON.stringify(commandName(line))} in: ${line.slice(0, 120)}`,
          ).toContain(commandName(line));
        }

        // Nothing in the hostile value may begin a line of its own that the
        // runner would read as a command. Values that themselves start with
        // `::` are the interesting case; the check derives its expectations
        // from the value rather than restating them here.
        for (const hostileLine of testCase.value.split(/\r?\n/)) {
          if (!hostileLine.startsWith("::")) {
            continue;
          }
          expect(
            result.lines.some((line) => line.startsWith(hostileLine)),
            `the hostile line ${JSON.stringify(hostileLine.slice(0, 60))} started a stdout line`,
          ).toBe(false);
          expect(commandName(hostileLine)).not.toBe(undefined);
        }

        // Exactly the documented outputs, so `injected=1` cannot become a key.
        expect(Object.keys(result.outputs).sort()).toEqual([...EXPECTED_OUTPUT_KEYS].sort());
        expect(result.outputs.status).toBe("fail");
        expect(result.outputs.failures).toBe("1");
        expect(result.outputs.report).toBeTruthy();
      } finally {
        fs.rmSync(result.workDir, { recursive: true, force: true });
      }
    });
  }

  it("an invalid case selection makes the engine exit non-zero and the Action report an execution failure", async () => {
    const result = await captureRun("this-case-does-not-exist");
    try {
      expect(result.outputs.status).toBe("execution-failed");
      const errors = result.lines.filter((line) => line.startsWith("::error"));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join("\n")).toContain("unknown HOSTILE_CASE");
    } finally {
      fs.rmSync(result.workDir, { recursive: true, force: true });
    }
  });
});

describe("markdown layer", () => {
  for (const testCase of ENFORCED_MARKDOWN_CASES) {
    it(`${testCase.name}: the summary structure is unchanged`, () => {
      const report = hostileReport(testCase.name);
      const markdown = renderSummaryMarkdown(report);
      const { prose } = splitDocument(markdown);
      const observation = observeMarkdown(report);

      // One verdict section, and only the headings the renderer writes: a
      // hostile `# ...` line must not become a heading.
      expect(observation.verdicts, "the verdict section must appear exactly once").toBe(1);
      expect(observation.headings).toEqual(SUMMARY_HEADINGS);

      // Every table keeps its column count: header, separator and data rows
      // all agree, so a hostile `|` added no cell.
      for (const table of observation.tables) {
        expect(table.length, "a table needs a header, a separator and at least one row").toBeGreaterThan(2);
        expect(new Set(table).size, `inconsistent column counts in table ${JSON.stringify(table)}`).toBe(1);
      }
      // Rows still correspond one-for-one to the report's results (the
      // surface table aggregates by surface) and to its skipped fixtures, so
      // no hostile newline added a row.
      expect((observation.tables[0]?.length ?? 0) - 2).toBe(
        new Set(report.results.map((result) => result.surface)).size,
      );
      expect((observation.tables[1]?.length ?? 0) - 2).toBe(report.skipped?.length ?? 0);

      // One bullet per failing result, so a hostile newline added no item.
      expect(observation.failureBullets).toBe(1);

      // Markdown syntax is shown literally on the escaping path. Engine text
      // reaches the document three ways: `escapeInline` (header fields, table
      // cells other than the fixture id, the failure summary), a code span
      // (the fixture id) and a fenced block (details). Only the first is
      // expected to escape syntax, so the check reads the header lines — the
      // parts rendered as ordinary prose with no code span around them.
      const headerText = prose
        .filter(
          (line) =>
            line.startsWith("Project: ") ||
            line.startsWith("Network: ") ||
            line.startsWith("Canary version: "),
        )
        .join("\n");
      expect(headerText).not.toBe("");
      if (testCase.value.includes("<script>")) {
        expect(headerText).not.toContain("<script>");
      }
      if (testCase.value.startsWith("# ")) {
        expect(headerText).not.toMatch(/^# not a heading/m);
      }
      if (testCase.value.startsWith("[") || testCase.value.startsWith("![")) {
        expect(headerText).not.toContain(testCase.value);
      }
      if (testCase.value.includes("|")) {
        expect(headerText).not.toContain("pipe | and");
      }
    });
  }

  for (const testCase of PENDING_FIX_CASES) {
    it(`${testCase.name}: recorded pending-fix observation is unchanged`, () => {
      const observed = serializeObservation(observeMarkdown(hostileReport(testCase.name)));
      expect(
        observed,
        `This Markdown finding changed. Review the new rendering, then update "observed" for ` +
          `${testCase.name} in tests/fixtures/hostile-strings.json and the PR description.`,
      ).toBe(testCase.observed);
    });
  }
});
