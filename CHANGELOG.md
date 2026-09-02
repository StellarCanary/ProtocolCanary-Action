# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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
