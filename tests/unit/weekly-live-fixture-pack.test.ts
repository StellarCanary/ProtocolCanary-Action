import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "weekly-live.yml");
const FIXTURES_COMMIT = "347ad6846d46b7bdf605a299501354563d79f2d9";
const FIXTURES_RELEASE = "fixtures-p29-v0.1.1";
const ENGINE_VERSION = "0.3.0";

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

const workflow = parse(fs.readFileSync(WORKFLOW_PATH, "utf8")) as {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: string; description?: string; required?: boolean }>;
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, { permissions?: Record<string, string>; strategy?: { matrix?: { include?: unknown[] } }; steps?: WorkflowStep[] }>;
};

describe("weekly Protocol 29 live integration fixture pack", () => {
  it("uses the immutable Protocol 29 release commit and pack directory", () => {
    const steps = workflow.jobs?.["live-check"]?.steps ?? [];
    const checkout = steps.find((step) => step.name === "Checkout ProtocolCanary-Fixtures");
    const canary = steps.find((step) => step.name === "Run Stellar Protocol Canary (this Action, from source)");

    expect(checkout?.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(checkout?.with).toMatchObject({
      repository: "StellarCanary/ProtocolCanary-Fixtures",
      path: "fixtures",
      ref: `\${{ inputs.fixtures_ref || '${FIXTURES_COMMIT}' }}`,
      "persist-credentials": false,
    });
    expect(canary?.with).toMatchObject({
      version: ENGINE_VERSION,
      protocol: "29",
      "fixtures-dir": "fixtures/protocol-29",
    });
  });

  it("keeps the optional manual override, both test networks, and scoped write permission", () => {
    const fixtureInput = workflow.on?.workflow_dispatch?.inputs?.fixtures_ref;
    const liveJob = workflow.jobs?.["live-check"];
    const trackerJob = workflow.jobs?.["track-failure"];
    const networkNames = (liveJob?.strategy?.matrix?.include ?? []).map((entry) => {
      if (typeof entry !== "object" || entry === null || !("network" in entry)) return undefined;
      return (entry as { network?: unknown }).network;
    });

    expect(fixtureInput?.required).toBe(false);
    expect(fixtureInput?.default).toBe("");
    expect(fixtureInput?.description).toContain(FIXTURES_RELEASE);
    expect(networkNames).toEqual(["testnet", "futurenet"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(trackerJob?.permissions).toEqual({ contents: "read", issues: "write" });
  });
});
