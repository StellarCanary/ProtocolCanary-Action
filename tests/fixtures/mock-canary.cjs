#!/usr/bin/env node
/*
 * A fake `stellar-canary` binary used only by this repository's own test
 * suite (see docs/mock-canary.md style contract below). It never talks to
 * a network and is never used outside `tests/`. Scenario is selected via
 * the MOCK_CANARY_SCENARIO environment variable; MOCK_CANARY_VERSION
 * overrides the version string reported by `version`.
 *
 * Supported scenarios: pass, warning, fail, config-error, rpc-error,
 * fixture-error, internal-error, malformed-json, timeout.
 */
"use strict";

const args = process.argv.slice(2);
const scenario = process.env.MOCK_CANARY_SCENARIO ?? "pass";
const version = process.env.MOCK_CANARY_VERSION ?? "0.1.0";

function baseReport(overrides) {
  return Object.assign(
    {
      schemaVersion: 1,
      toolVersion: version,
      targetProtocol: 28,
      project: { name: "mock-project", type: "soroban" },
      status: "pass",
      counts: { total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
      results: [],
      git: { commit: "deadbeef", branch: "main", isDirty: false },
    },
    overrides,
  );
}

function emit(report, exitCode) {
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exit(exitCode);
}

function fail(exitCode, message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(exitCode);
}

if (args[0] === "version") {
  process.stdout.write(`stellar-canary ${version}\n`);
  process.exit(0);
}

if (args[0] !== "check") {
  fail(2, `mock-canary does not implement subcommand ${JSON.stringify(args[0])}`);
}

switch (scenario) {
  case "pass": {
    emit(
      baseReport({
        status: "pass",
        counts: { total: 1, passed: 1, failed: 0, warnings: 0, errors: 0, skipped: 0 },
        results: [
          {
            testId: "p28-xdr-cap83-empty-tx-set",
            protocol: 28,
            surface: "xdr",
            status: "pass",
            summary: "StellarValue round-tripped byte-for-byte",
            durationMs: 1,
            fixtureId: "p28-xdr-cap83-empty-tx-set",
          },
        ],
      }),
      0,
    );
    break;
  }

  case "warning": {
    // Modeled on the default policy (`warnings_are_failures = false`):
    // a warning-only run does not fail the process.
    emit(
      baseReport({
        status: "warning",
        counts: { total: 1, passed: 0, failed: 0, warnings: 1, errors: 0, skipped: 0 },
        results: [
          {
            testId: "p28-rpc-get-network",
            protocol: 28,
            surface: "rpc",
            status: "warning",
            summary: "getNetwork responded, but passphrase field was empty",
            details: "Expected a non-empty string passphrase.",
            durationMs: 42,
            fixtureId: "p28-rpc-get-network",
          },
        ],
      }),
      0,
    );
    break;
  }

  case "fail": {
    emit(
      baseReport({
        status: "fail",
        counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 0 },
        results: [
          {
            testId: "p28-xdr-cap83-empty-tx-set",
            protocol: 28,
            surface: "xdr",
            status: "fail",
            summary: "failed to decode StellarValue",
            details: "Invalid symbol 45, offset 3.",
            durationMs: 0,
            fixtureId: "p28-xdr-cap83-empty-tx-set",
          },
        ],
      }),
      1,
    );
    break;
  }

  case "config-error": {
    fail(2, "configuration error: unsupported config version 2");
    break;
  }

  case "rpc-error": {
    // An execution error surfaced as a per-fixture Error result, still
    // with a full report on stdout (contrast with fixture-error/
    // internal-error below, which fail before a report can be built).
    emit(
      baseReport({
        status: "error",
        counts: { total: 1, passed: 0, failed: 0, warnings: 0, errors: 1, skipped: 0 },
        results: [
          {
            testId: "p28-rpc-get-network",
            protocol: 28,
            surface: "rpc",
            status: "error",
            summary: "RPC request failed",
            details: "connection timed out after 3 attempts",
            durationMs: 3000,
            fixtureId: "p28-rpc-get-network",
          },
        ],
      }),
      3,
    );
    break;
  }

  case "fixture-error": {
    fail(4, "invalid fixture: duplicate fixture id \"p28-xdr-cap83-empty-tx-set\"");
    break;
  }

  case "internal-error": {
    fail(5, "internal error: unreachable state");
    break;
  }

  case "malformed-json": {
    process.stdout.write("{ this is not valid json");
    process.exit(0);
    break;
  }

  case "timeout": {
    setTimeout(() => {
      process.stdout.write(JSON.stringify(baseReport({})) + "\n");
      process.exit(0);
    }, 10_000);
    break;
  }

  default:
    fail(5, `unknown MOCK_CANARY_SCENARIO ${JSON.stringify(scenario)}`);
}
