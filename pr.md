# Pull Request

## What changed?

Added end-to-end assertions for the `report` output in `tests/integration/end-to-end.test.ts:135-148,177-190`.

- `pass: succeeds, sets outputs, and writes no annotations` now asserts `path.isAbsolute(outputs.report)` and `fs.existsSync(outputs.report)` at `tests/integration/end-to-end.test.ts:146-147`
- `fail: fails the job and annotates the failing check` now asserts the same at `tests/integration/end-to-end.test.ts:187-188`

This verifies the contract documented in `action.yml:111-116` (“Absolute path to the generated JSON report file”) and the `fs.writeFileSync(reportFilePath(), ...)` / `core.setOutput("report", reportPath)` path in `src/main.ts:16-19,97-100,143`.

`path` and `fs` were already imported at `tests/integration/end-to-end.test.ts:1,3`; no new dependencies.

## Why?

`readOutputs` at `tests/integration/end-to-end.test.ts:101-119` parses every GitHub Actions output as a raw string, but prior tests only checked `outputs.status`/`outputs.passed`/`outputs.failures`. The `report` output is a documented, consumer-facing value (used to upload/inspect the JSON report in a later step). Without checking that it is an absolute path and that the file exists on disk, a regression in `reportFilePath()` (`src/main.ts:16`) or the `fs.writeFileSync` call (`src/main.ts:99`) could go undetected.

## Tests performed

- [x] `npm test -- tests/integration/end-to-end.test.ts` — 1 file / 9 tests passed (pass, pass-no-counts, warning, fail, config-error, rpc-error, fixture-error, internal-error, malformed-json)
- [x] `npm run typecheck` — passes
- [x] `npm run lint` — no new warnings
- [x] `npm run build` — not required (test-only change, `dist/` unaffected)

Manual check: verified `outputs.report` is e.g. `/tmp/canary-e2e-…/runner-temp/stellar-canary-report.json` and `fs.existsSync` is `true` for the mocked `stellar-canary` runs.

## Related issue

Closes: Add an integration test assertion that the report output is a valid, existing absolute path

Component: `tests/integration/end-to-end.test.ts`

## Compatibility impact

None. Test-only change. No input/output contract change; validates existing `report` output documented at `action.yml:111`.

## Breaking change?

- [ ] Yes — described above
- [x] No
