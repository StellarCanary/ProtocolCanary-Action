# Shared contracts

The interfaces this Action shares with `Protocol-Canary` and
`ProtocolCanary-Fixtures` are defined once, in
[`Protocol-Canary/docs/contracts/`](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/README.md).
This page lists what each contract asks of the Action. It does not repeat the
rules.

The Action stays a thin wrapper: the CLI decides compatibility, verifies
fixture digests and lockfiles, and computes comparisons. The Action runs it and
shows the answer. Some of the work below is implemented; the rest is
incomplete or waits on a CLI release. The table separates the two.

| Contract | What the Action does | Status |
|---|---|---|
| [CF-01 Report](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-01-report.md) | Validates reports as section 7 describes (`parseReport` in `src/output.ts`), tolerates reserved additive fields, rejects duplicate result identities, and never shows a zero-check run as a success (`allow-empty` must be set to accept one). | Implemented |
| [CF-03 Lockfile](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-03-lockfile.md) | Would surface the CLI's lock verification result and not parse digests itself. | Not implemented: the Action has no lockfile handling today |
| [CF-05 Comparison](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-05-report-comparison.md) | The `baseline-report` input is validated before the run (the file must exist and be a complete schemaVersion 1 report) and its target protocol must match the run's. The CLI `diff` command is not released (#335), so the baseline is not passed to it and the Action produces no comparison or regression verdict. | Partial: baseline validation only; comparison deferred until `diff` ships |
| [CF-06 Fixture releases](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-06-fixture-releases.md) | `fixtures-pack-version` and `fixtures-pack-protocol` are validated (an unpinned tag such as `latest` is rejected) and the Action logs a note when they are set, but they are not forwarded: `stellar-canary check` has no fixture-pack flag. The Action does not download a pack, check an archive checksum or hand a pack to the CLI. To pin a pack, check out its tag into `fixtures-dir`. | Partial: input validation and logging only; download and verification deferred |
| [CF-07 Project roots](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-07-project-roots-and-detection.md) | Maps a `working-directory` input to the CLI's `--project-root`. | Implemented |
| [CF-08 Viewer and Action](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-08-viewer-and-action.md) | Defines the inputs, outputs, failure mapping, diagnostics redaction and summary limits. Current inputs and outputs are listed below. | Partly implemented; compare the contract with `action.yml` for what remains |

## Engine exit codes

The engine (`stellar-canary`) exits with one of the following codes. The Action
maps each code to a workflow outcome; the mapping is implemented in `action.yml`
and tested by `tests/unit/exit-codes.test.ts`.

| Exit code | Meaning | Action behaviour |
|---|---|---|
| `0` | Pass — all checks ran and passed. | Sets `status=pass`; does not fail the job unless `fail-on-warning` applies. |
| `1` | Fail — one or more checks produced a failure result. | Sets `status=fail`; fails the job. |
| `2` | Usage / configuration error — the CLI was invoked incorrectly or rejected the config. | Sets `status=execution-failed`; fails the job. Exit code 2 is also produced in 0.2.0+ when no fixture applies and `--allow-empty` was not passed. |
| `3` | Execution error — the CLI ran but could not complete (e.g. the project root was unreadable or an RPC endpoint was unreachable). | Sets `status=execution-failed`; fails the job. |
| `4` | Protocol mismatch — the target protocol differs from the protocol observed on the network. Added in v0.2.0. | Sets `status=execution-failed`; fails the job. |
| `5` | Missing binary — the requested `stellar-canary` binary could not be found after installation. | Sets `status=execution-failed`; fails the job. |

Any exit code not listed above (including negative values or codes above 5) is
treated as an execution error equivalent to exit code 3.

## Execution receipt fields

When `generate-receipt: true`, the Action writes a JSON file at the path given
by the `receipt-path` output. The receipt follows `receiptVersion: 1`
(`src/receipt.ts`). Every top-level field is present by construction; string
fields fall back to the literal `"unknown"` when the report did not carry the
value.

| Field | Type | Description |
|---|---|---|
| `receiptVersion` | `number` (always `1`) | Schema version pin. Consumers must reject receipts with an unrecognised version. |
| `engineVersion` | `string` | The `toolVersion` from the Canary report — the engine's own semver string. `"unknown"` when the report omits it. |
| `engineCommit` | `string` | Build commit of the engine binary (`run.toolBuildCommit` or the future `engineCommit` report field). `"unknown"` for engines that predate E-055. |
| `packDigest` | `string` | Digest identifying the fixture pack (`fixturePack.digest` or the future `packDigest` field). `"unknown"` for engines that predate E-071. |
| `protocol` | `number \| "unknown"` | Protocol the run targeted (`targetProtocol`), as a positive integer, or `"unknown"` when absent. |
| `observedProtocol` | `number \| "unknown"` | Protocol observed live on the network (`network.observedProtocol`), or `"unknown"` for offline runs. |
| `timestamp` | `string` | ISO-8601 UTC timestamp recorded when the receipt was built. |

All string fields pass through the CF-08 redaction boundary: recognised
credential shapes and machine-specific absolute filesystem paths are replaced
with `[REDACTED]`. Semantic identifiers (hex commit SHAs, `sha256:` digests,
semver, ISO-8601 timestamps) are preserved verbatim.

## Facts about this repository that the contracts rely on

Checked against `main` at `f5b9072` on 2026-11-20. `action.yml` is the
authority for the full list and defaults; this is a summary.

- Inputs: `protocol`, `config`, `working-directory`, `network`,
  `network-passphrase`, `rpc-max-retries`, `rpc-retry-delay-ms`, `rpc-url`,
  `fixtures-dir`, `fixture`, `surface`, `cache-dir`, `version`, `upload-report`,
  `report-retention-days`, `annotations`, `diagnostics`, `timeout-minutes`,
  `allow-empty`, `rpc-timeout-seconds`, `max-concurrency`, `no-cache`,
  `live-cache-ttl-seconds`, `fail-on-warning`, `offline`,
  `fixtures-pack-version`, `fixtures-pack-protocol`, `baseline-report`,
  `github-token`, `strict-integrity`, `pr-comment`, `junit-report`,
  `engine-env-passthrough` and `generate-receipt`.
- Outputs: `status`, `passed`, `warnings`, `failures`, `errors`, `total`,
  `skipped`, `replayed-count`, `engine-version`, `observed-protocol`,
  `pack-protocol`, `pack-version`, `pack-digest`, `report`, `coverage-state`,
  `receipt-path`, `junit-report-path`, `artifact-name` and `artifact-id`.
- `fixtures-pack-version`, `fixtures-pack-protocol` and `baseline-report` are
  the inputs whose contract work is incomplete (see CF-05 and CF-06 above).
- Engine installation: see [download-policy.md](download-policy.md) and
  [integrity-model.md](integrity-model.md). A downloaded release binary needs an
  exact platform asset checksum; `strict-integrity: true` also rejects source
  builds, including cached ones. A checksum proves integrity, not the release
  author's identity, and release signing is deferred.
- When the engine cannot run or the report cannot be parsed, no report artifact
  is uploaded, and `status` is `execution-failed`.
