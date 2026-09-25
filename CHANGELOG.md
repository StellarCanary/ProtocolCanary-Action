# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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
