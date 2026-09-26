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

- Default `version` input bumped from `0.1.0` to `0.1.1`
  ([0de71ec](https://github.com/StellarCanary/ProtocolCanary-Action/commit/0de71ec578c7520163ab41ef0b32ea25f5dac53b)).
  Protocol-Canary `v0.1.1` adds `ContractExecutable` XDR type support,
  which 2 of the 5 current `ProtocolCanary-Fixtures` Protocol 28 fixtures
  require and `v0.1.0` cannot parse at all. Found and closed during
  three-repository E2E validation.

### Fixed

- `parseReport` no longer rejects a schemaVersion-1 report that omits the
  `counts` field
  ([810a029](https://github.com/StellarCanary/ProtocolCanary-Action/commit/810a029f6a380eee5987a936045d3a51e890de7a)).
  Protocol-Canary's actual tagged `v0.1.0` release (this Action's pinned
  default) predates `counts`, so every check against it — even a fully
  passing one — was previously misreported as an execution failure. Found
  during three-repository E2E validation; `counts` is now derived from
  `results`/`skipped` when absent.

## [0.1.0]

- `stellar-canary check --format json` integration: typed input handling
  ([e71472a](https://github.com/StellarCanary/ProtocolCanary-Action/commit/e71472acd308a236036ddc68ff2166ced795bc0e)),
  pinned-commit installation via `cargo install --git`
  ([90d6ff4](https://github.com/StellarCanary/ProtocolCanary-Action/commit/90d6ff45f918a4d40ed571b9b4d2cbc27fadef3f))
  (no prebuilt release binaries exist upstream yet), safe subprocess
  execution with a configurable timeout and signal forwarding
  ([e3ecd2e](https://github.com/StellarCanary/ProtocolCanary-Action/commit/e3ecd2e791e525dc98edbfab49ef8e3a11b4e27e)).
- GitHub job summary
  ([ac55978](https://github.com/StellarCanary/ProtocolCanary-Action/commit/ac5597810244c97c32498636a62d2bd25ceec0c2))
  and annotations
  ([3c86513](https://github.com/StellarCanary/ProtocolCanary-Action/commit/3c86513e95ef088ced42cbaf17ddceac754c0a77))
  rendered from the CLI's own JSON report — never a second invocation,
  never a reinterpreted result.
- Optional upload of the JSON report as a `stellar-protocol-canary-report`
  workflow artifact
  ([223c108](https://github.com/StellarCanary/ProtocolCanary-Action/commit/223c108a4f86d61691f8dd84fcfd7c961979249f));
  upload failure never changes the underlying compatibility result.
- Full exit-code contract support (0 pass, 1 compatibility failure, 2
  configuration error, 3 execution/RPC error, 4 invalid fixture, 5
  internal error)
  ([4bd2f83](https://github.com/StellarCanary/ProtocolCanary-Action/commit/4bd2f839974e127c25bc04585254e0ddfc499fef)),
  with a clear distinction between an execution failure (Canary could not
  run) and a compatibility failure (it ran and found a real problem).
- Unit and integration test suite against a mock Canary binary covering
  every documented result state
  ([e3ecd2e](https://github.com/StellarCanary/ProtocolCanary-Action/commit/e3ecd2e791e525dc98edbfab49ef8e3a11b4e27e));
  a separate, non-gating live workflow against a real build and Stellar
  Testnet
  ([0fce241](https://github.com/StellarCanary/ProtocolCanary-Action/commit/0fce2411d4bb2d2fc4c4d24ed8d8b454434763c2)).

### Known gaps

- `Protocol-Canary` does not yet publish signed/checksummed release
  binaries, so this Action builds it from a pinned source commit instead
  of downloading a verified artifact — see `SECURITY.md`
  ([87c5270](https://github.com/StellarCanary/ProtocolCanary-Action/commit/87c5270e242a6ddabee7a18ad4dced2becb69975)).
- Only Protocol 28 has fixtures published upstream at this time
  ([87c5270](https://github.com/StellarCanary/ProtocolCanary-Action/commit/87c5270e242a6ddabee7a18ad4dced2becb69975)).
