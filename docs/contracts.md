# Shared contracts

The interfaces this Action shares with `Protocol-Canary` and
`ProtocolCanary-Fixtures` are defined once, in
[`Protocol-Canary/docs/contracts/`](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/README.md).
This page lists what each contract asks of the Action. It does not repeat the
rules.

The Action stays a thin wrapper: the CLI decides compatibility, verifies
fixture digests and lockfiles, and computes comparisons. The Action runs it and
shows the answer. None of the work below exists yet.

| Contract | What the Action does |
|---|---|
| [CF-01 Report](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-01-report.md) | Validates reports as section 7 describes, tolerates reserved additive fields, rejects duplicate result identities, and never shows a zero-check run as a success. |
| [CF-03 Lockfile](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-03-lockfile.md) | Surfaces the CLI's lock verification result. Does not parse digests itself. |
| [CF-05 Comparison](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-05-report-comparison.md) | Passes a baseline report to the CLI `diff` command and shows its output. |
| [CF-06 Fixture releases](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-06-fixture-releases.md) | Downloads a pack over HTTPS with redirect and size limits, checks the archive checksum, then hands verification and extraction to the CLI. |
| [CF-07 Project roots](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-07-project-roots-and-detection.md) | Maps a `working-directory` input to the CLI's `--project-root`. |
| [CF-08 Viewer and Action](https://github.com/StellarCanary/Protocol-Canary/blob/main/docs/contracts/cf-08-viewer-and-action.md) | Defines the proposed inputs, outputs, failure mapping, diagnostics redaction and summary limits. |

## Facts about this repository that the contracts rely on

Checked against `main` at `0f6caab` on 2026-10-09:

- Inputs: `protocol`, `config`, `network`, `rpc-url`, `fixtures-dir`, `version`,
  `upload-report`, `annotations`, `timeout-minutes` (and `allow-empty`, added after that commit). Outputs: `status`, `passed`,
  `warnings`, `failures`, `errors`, `report`.
- The Action installs the engine with `cargo install --git --locked` pinned to
  the resolved commit, and verifies an installed binary against the engine
  release's checksum manifest when one exists.
- When the engine cannot run or the report cannot be parsed, no report artifact
  is uploaded.
- Open pull requests that overlap and conflict with `main`: #321 and #288 (issue
  #251), #320 and #302 (issue #283), #319 (issue #67, already fixed by merged
  #115), and #132 with #140 (issue #33).
