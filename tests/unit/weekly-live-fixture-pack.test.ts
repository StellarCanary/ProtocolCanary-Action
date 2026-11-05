import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.join(__dirname, "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "weekly-live.yml");
const ENGINE_VERSION = "0.3.0";
const P29_COMMIT = "347ad6846d46b7bdf605a299501354563d79f2d9";
const P30_COMMIT = "9feb1a85f64cd43201685fe233bf9ef15a38a752";

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface MatrixEntry {
  network: string;
  protocol: string;
  fixtures_commit: string;
  fixtures_label: string;
  fixtures_dir: string;
  "rpc-url": string;
  passphrase: string;
}
interface Job {
  env?: Record<string, unknown>;
  permissions?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { include?: MatrixEntry[] } };
  steps?: Step[];
}
const workflow = parse(fs.readFileSync(WORKFLOW, "utf8")) as {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: string; description?: string; required?: boolean }>;
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
};

describe("weekly Testnet P30 identity and Futurenet P29 live checks", () => {
  it("pins separate immutable fixture commits, target protocols and directories", () => {
    const matrix = workflow.jobs?.["live-check"]?.strategy?.matrix?.include;
    expect(matrix).toEqual([
      {
        network: "testnet",
        protocol: "30",
        fixtures_commit: P30_COMMIT,
        fixtures_label: "Protocol 30 Testnet identity (unreleased commit)",
        fixtures_dir: "fixtures/protocol-30",
        "rpc-url": "https://soroban-testnet.stellar.org",
        passphrase: "Test SDF Network ; September 2015",
      },
      {
        network: "futurenet",
        protocol: "29",
        fixtures_commit: P29_COMMIT,
        fixtures_label: "fixtures-p29-v0.1.1 release",
        fixtures_dir: "fixtures/protocol-29",
        "rpc-url": "https://rpc-futurenet.stellar.org",
        passphrase: "Test SDF Future Network ; October 2022",
      },
    ]);
    expect(workflow.jobs?.["live-check"]?.strategy?.["fail-fast"]).toBe(false);
    expect(workflow.jobs?.["live-check"]?.env).toMatchObject({
      TARGET_PROTOCOL: "${{ matrix.protocol }}",
      NETWORK_NAME: "${{ matrix.network }}",
    });
  });

  it("uses the matching matrix pin or explicit manual override without credentials", () => {
    const steps = workflow.jobs?.["live-check"]?.steps ?? [];
    const checkout = steps.find((step) => step.name === "Checkout ProtocolCanary-Fixtures");
    const canary = steps.find((step) => step.name === "Run Stellar Protocol Canary (this Action, from source)");
    const summary = steps.find((step) => step.name === "Record the fixtures pack under test");

    expect(checkout?.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(checkout?.with).toMatchObject({
      repository: "StellarCanary/ProtocolCanary-Fixtures",
      path: "fixtures",
      ref: "${{ inputs.fixtures_ref || matrix.fixtures_commit }}",
      "persist-credentials": false,
    });
    expect(canary?.with).toMatchObject({
      version: ENGINE_VERSION,
      protocol: "${{ matrix.protocol }}",
      "fixtures-dir": "${{ matrix.fixtures_dir }}",
      network: "${{ matrix.network }}",
      "rpc-url": "${{ matrix.rpc-url }}",
    });
    expect(summary?.env).toMatchObject({
      REQUESTED_FIXTURES_REF: "${{ inputs.fixtures_ref }}",
      PINNED_FIXTURES_LABEL: "${{ matrix.fixtures_label }}",
      SELECTED_FIXTURES_DIR: "${{ matrix.fixtures_dir }}",
    });
  });

  it("preserves manual override, read-only network jobs and one main-only tracker", () => {
    const input = workflow.on?.workflow_dispatch?.inputs?.fixtures_ref;
    expect(input?.required).toBe(false);
    expect(input?.default).toBe("");
    expect(input?.description).toContain("both networks");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs?.["live-check"]?.permissions).toBeUndefined();
    expect(workflow.jobs?.["track-failure"]?.permissions).toEqual({
      contents: "read",
      issues: "write",
    });
  });
});
