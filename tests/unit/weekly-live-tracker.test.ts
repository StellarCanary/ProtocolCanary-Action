import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "weekly-live.yml");
const REPOSITORY = "StellarCanary/ProtocolCanary-Action";

interface TrackerStep {
  id?: string;
  run?: string;
}

interface TrackerJob {
  if?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: TrackerStep[];
}

const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as {
  jobs: Record<string, TrackerJob>;
};
const trackerJob = workflow.jobs["track-failure"];
const trackerScript = trackerJob?.steps.find((step) => step.id === "tracking")?.run;

function runTracker(scenario: "missing-label" | "existing-issue" | "label-list-error", outcome: string) {
  if (!trackerScript) {
    throw new Error("weekly-live tracker step was not found");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-live-tracker-"));
  const binDir = path.join(root, "bin");
  const callsPath = path.join(root, "gh-calls.jsonl");
  fs.mkdirSync(binDir);

  const fakeGh = path.join(binDir, "gh");
  fs.writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const repo = process.env.GH_REPO;
if (repo !== "${REPOSITORY}") {
  console.error("gh was not given a repository context");
  process.exit(90);
}
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
const scenario = process.env.GH_SCENARIO;
if (args[0] === "label" && args[1] === "list") {
  if (scenario === "label-list-error") {
    console.error("simulated label API failure");
    process.exit(23);
  }
  process.stdout.write(scenario === "missing-label" ? "bug\\n" : "weekly-live\\n");
} else if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(scenario === "existing-issue" ? "42\\n" : "\\n");
}
`,
  );
  fs.chmodSync(fakeGh, 0o755);

  try {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", trackerScript], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GH_CALLS: callsPath,
        GH_REPO: REPOSITORY,
        GITHUB_REPOSITORY: REPOSITORY,
        GH_SCENARIO: scenario,
        GH_TOKEN: "test-token",
        TRACKING_LABEL: "weekly-live",
        RUN_OUTCOME: outcome,
        RUN_URL: "https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/123",
      },
    });
    const calls = fs.existsSync(callsPath)
      ? fs
          .readFileSync(callsPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
      : [];
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function hasCall(calls: string[][], command: string, subcommand?: string): boolean {
  return calls.some((args) => args[0] === command && (subcommand === undefined || args[1] === subcommand));
}

describe("weekly live failure tracker", () => {
  it("runs the issue-writing job only on main with the intended repository and permission", () => {
    expect(trackerJob?.if).toContain("github.ref == 'refs/heads/main'");
    expect(trackerJob?.permissions).toEqual({ contents: "read", issues: "write" });
    expect(trackerJob?.env?.GH_REPO).toBe("${{ github.repository }}");
  });

  it.skipIf(process.platform === "win32")("creates a missing label before opening the single tracking issue", () => {
    const result = runTracker("missing-label", "failure");

    expect(result.status).toBe(0);
    expect(hasCall(result.calls, "label", "create")).toBe(true);
    expect(hasCall(result.calls, "issue", "create")).toBe(true);
    expect(hasCall(result.calls, "issue", "comment")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("comments on an existing issue instead of opening a duplicate", () => {
    const result = runTracker("existing-issue", "failure");

    expect(result.status).toBe(0);
    expect(hasCall(result.calls, "issue", "comment")).toBe(true);
    expect(hasCall(result.calls, "issue", "create")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("closes an existing tracking issue after a green run", () => {
    const result = runTracker("existing-issue", "success");

    expect(result.status).toBe(0);
    expect(hasCall(result.calls, "issue", "comment")).toBe(true);
    expect(hasCall(result.calls, "issue", "close")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("preserves label API errors instead of reporting a missing label", () => {
    const result = runTracker("label-list-error", "failure");

    expect(result.status).toBe(23);
    expect(result.stderr).toContain("simulated label API failure");
    expect(result.stderr).not.toContain("label does not exist");
    expect(hasCall(result.calls, "label", "create")).toBe(false);
    expect(hasCall(result.calls, "issue", "create")).toBe(false);
  });
});
