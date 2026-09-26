# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Documentation

- README gains a "Troubleshooting" section mapping the most common
  execution-failure messages (`cargo` not found, `cargo install` exit
  101, timeouts, unparsable reports, unsupported `schemaVersion`, missing
  config file) to concrete next steps, cross-referenced with the bug
  report template's "Which kind of failure?" checklist; the Outputs table
  now shows an example value for every output.
- Quick start now says that `fixtures-dir` defaults to `fixtures` and that
  a fresh checkout has no such directory, pointing at
  `examples/protocol-28.yml` for a complete workflow; CONTRIBUTING.md
  notes that Dependabot opens its own dependency PRs under the same
  review expectations; the pull request template now prompts for an
  `[Unreleased]` entry on user-facing changes.
- README.md gained a Table of Contents linking every top-level section, and
  "How failures appear" now shows the actual rendered job summary for a
  passing run, a run with failures/warnings, and an execution failure,
  instead of describing the format only in prose.

### Added

- Checksum verification: when `StellarCanary/Protocol-Canary` publishes a
  checksum manifest alongside a release, the installed or cached binary is
  verified against it before use, and a mismatch fails the run with an
  `InstallationFailed` error. Until such a manifest exists the check is a
  no-op debug log, so commit/tag pinning is unchanged — see `SECURITY.md`.
- `npm run test:coverage` produces v8 line/branch coverage for `src/`
  (terminal, HTML, and lcov reports; contributor-facing only — no effect
  on the Action's behavior).

### Changed

- The tag lookup that pins installs to an immutable commit now sends a
  `GITHUB_TOKEN` bearer credential when one is available and follows
  pagination across every page of the tags endpoint. A shared runner IP
  hitting the 60/hour unauthenticated limit, or a repository growing past
  100 tags, can no longer silently degrade installation to tag-based
  pinning.
- Third-party actions in `.github/workflows/*.yml` are pinned to full
  commit SHAs (with the human-readable version kept as a trailing comment)
  instead of mutable version tags, closing a supply-chain hole — most
  importantly in `release.yml`, which runs with `contents: write`.

### Testing

- Added unit coverage for `runCheck`'s `SIGINT`/`SIGTERM` forwarding to the
  child process, for cleanup of those listeners after settling, and for the
  cancellation branch where the child exits with a null code and a signal.

## [0.1.1]

### Changed

- Default `version` input bumped from `0.1.0` to `0.1.1`. Protocol-Canary
  `v0.1.1` adds `ContractExecutable` XDR type support, which 2 of the 5
  current `ProtocolCanary-Fixtures` Protocol 28 fixtures require and
  `v0.1.0` cannot parse at all. Found and closed during three-repository
  E2E validation.

### Fixed

- `parseReport` no longer rejects a schemaVersion-1 report that omits the
  `counts` field. Protocol-Canary's actual tagged `v0.1.0` release (this
  Action's pinned default) predates `counts`, so every check against it —
  even a fully passing one — was previously misreported as an execution
  failure. Found during three-repository E2E validation; `counts` is now
  derived from `results`/`skipped` when absent.

## [0.1.0]

- `stellar-canary check --format json` integration: typed input handling,
  pinned-commit installation via `cargo install --git` (no prebuilt
  release binaries exist upstream yet), safe subprocess execution with a
  configurable timeout and signal forwarding.
- GitHub job summary and annotations rendered from the CLI's own JSON
  report — never a second invocation, never a reinterpreted result.
- Optional upload of the JSON report as a `stellar-protocol-canary-report`
  workflow artifact; upload failure never changes the underlying
  compatibility result.
- Full exit-code contract support (0 pass, 1 compatibility failure, 2
  configuration error, 3 execution/RPC error, 4 invalid fixture, 5
  internal error), with a clear distinction between an execution failure
  (Canary could not run) and a compatibility failure (it ran and found a
  real problem).
- Unit and integration test suite against a mock Canary binary covering
  every documented result state; a separate, non-gating live workflow
  against a real build and Stellar Testnet.

### Known gaps

- `Protocol-Canary` does not yet publish signed/checksummed release
  binaries, so this Action builds it from a pinned source commit instead
  of downloading a verified artifact — see `SECURITY.md`.
- Only Protocol 28 has fixtures published upstream at this time.
