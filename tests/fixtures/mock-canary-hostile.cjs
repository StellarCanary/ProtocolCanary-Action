#!/usr/bin/env node
/*
 * A hostile `stellar-canary` stand-in for issue #434. It prints a
 * schemaVersion-1 report whose engine-provided text (testId, summary,
 * details, skipped reason, project.name, network.name) is one value from
 * tests/fixtures/hostile-strings.json, selected with the HOSTILE_CASE
 * environment variable.
 *
 * `mock-canary.cjs` is deliberately not touched: that fixture models the
 * engine's documented behaviour, while this one models an untrusted
 * repository reporting arbitrary text.
 *
 * Usage (the shape the Action invokes):
 *
 *   HOSTILE_CASE=starts-with-command node mock-canary-hostile.cjs check --format json
 *
 * The report always describes one failing XDR fixture plus one skipped
 * fixture, so both the annotation path and the summary's failure list and
 * skipped table carry the hostile value. The process exits 1, the engine's
 * documented compatibility-failure code, so the Action treats it as a real
 * result rather than an execution failure.
 *
 * An unknown or missing HOSTILE_CASE exits 5 with a diagnostic on stderr:
 * that is how the negative test checks that a bad selection reaches the
 * Action as an execution failure instead of silently producing a report.
 *
 * The cases file is read from next to this script, so a copy installed as
 * <RUNNER_TEMP>/stellar-canary-action/bin/stellar-canary finds its copy of
 * the file in the same directory. Nothing here touches the network.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const VERSION = "0.1.0";
const CASES_PATH = path.join(__dirname, "hostile-strings.json");
const args = process.argv.slice(2);

/**
 * Writes `text` to a file descriptor synchronously.
 *
 * `process.stdout.write(...)` followed by `process.exit(...)` can drop part
 * of a large report: writes to a pipe are asynchronous, and a single hostile
 * value appears in several fields, so the report is far bigger than the pipe
 * buffer. A partial write would reach the Action as truncated JSON and be
 * reported as an execution failure, hiding the case under test. Writing with
 * `fs.writeSync` and looping over partial writes makes the output complete
 * before the process exits.
 */
function writeAll(fd, text) {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

/**
 * Writes `error: <message>` to stderr and terminates with `exitCode`, using
 * the engine's documented configuration/internal-error exit codes.
 */
function fail(exitCode, message) {
  writeAll(2, `error: ${message}\n`);
  process.exit(exitCode);
}

if (args[0] === "version") {
  writeAll(1, `stellar-canary ${VERSION}\n`);
  process.exit(0);
}

if (args[0] !== "check") {
  fail(2, `hostile mock does not implement subcommand ${JSON.stringify(String(args[0]))}`);
}

const selected = process.env.HOSTILE_CASE;

let cases;
try {
  cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8")).cases;
} catch (error) {
  fail(5, `could not read ${CASES_PATH}: ${error instanceof Error ? error.message : String(error)}`);
}

const testCase = Array.isArray(cases) ? cases.find((entry) => entry.name === selected) : undefined;
if (testCase === undefined) {
  fail(
    5,
    `unknown HOSTILE_CASE ${JSON.stringify(String(selected))}. ` +
      `Expected one of: ${(cases ?? []).map((entry) => entry.name).join(", ")}`,
  );
}

const value = testCase.value;

// The same hostile value in every engine-provided field the Action renders:
// the identifier and summary reach @actions/core annotations, while details,
// the skip reason, the project name and the network name only reach the
// Markdown summary.
const report = {
  schemaVersion: 1,
  toolVersion: VERSION,
  targetProtocol: 28,
  project: { name: value, type: "soroban" },
  network: { name: value, observedProtocol: 28 },
  status: "fail",
  counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 1 },
  results: [
    {
      testId: value,
      protocol: 28,
      surface: "xdr",
      status: "fail",
      summary: value,
      details: value,
      durationMs: 1,
      fixtureId: value,
    },
  ],
  skipped: [{ fixtureId: value, surface: "xdr", reason: value, code: "UNKNOWN" }],
  git: { commit: "deadbeef", branch: "main", isDirty: false },
};

writeAll(1, JSON.stringify(report) + "\n");
process.exit(1);
