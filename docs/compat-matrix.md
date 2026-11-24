# Compatibility Matrix

This document describes `.github/workflows/compat-matrix.yml` and the evidence it produces.

## Scope and execution mode

The scheduled and manually dispatched matrix checks Engine CLI builds against selected Fixtures refs. Each cell checks out both refs, builds `stellar-canary` from that Engine ref, and invokes the CLI directly with the selected Fixture pack. The workflow does not invoke this repository's composite Action.

Every matrix cell targets Protocol 28 and uses `tests/fixtures/real-engine/offline.stellar-canary.toml`. That config enables XDR checks and disables RPC and Soroban checks. The matrix therefore executes local XDR assertions and does not query Testnet or Futurenet. RPC and Soroban results are outside this matrix's coverage. The report records `executionMode: "offline-xdr"` and the job summary repeats that scope.

The `protocol-28` Fixtures tag resolves to commit `75ec2c293a44f09d9c8c1f76722a24a2334ac20a`. It is the immutable pack tag verified for the Protocol 28 release. The workflow also allows other refs, including the moving `main` branch, and records each resolved commit in the cell facts. A passing `offline-xdr` cell supports only the XDR checks that ran. It does not establish RPC, Soroban, full-pack or Action-wrapper compatibility.

The live Testnet and Futurenet canary is kept in `.github/workflows/weekly-live.yml`. That workflow is separate from this matrix. Its live observations are not offline compatibility results.

### Action-wrapper coverage

This matrix builds and calls the Engine CLI directly. It does not load `action.yml` or invoke `src/main.run()` for each selected Engine and Fixtures pair, so it is not a three-component compatibility test.

`.github/workflows/engine-compat.yml` separately runs `tests/integration/real-engine.test.ts`, which calls the Action's `run()` function with real Engine binaries and a small Action-owned offline XDR fixture. `.github/workflows/weekly-live.yml` separately invokes the composite Action with an external Fixtures checkout and live networks. Neither workflow exercises every pair selected by this matrix. Per-pair Action-wrapper integration remains separate maintenance work.

## Verified compatibility limits

Protocol 28 is now served by Testnet as protocol 29. Before the offline config was added, run [41446142522](https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/41446142522) recorded the `protocolVersion` assertion expecting 28 and observing 29 for both released Engines. The cause was the matrix's default live CLI configuration, not a runner outage. The XDR-only config prevents that live assertion from running in this matrix; live network status remains separate.

Fixtures `main` contains `protocol-28/soroban/p28-soroban-sim-error-arg-type.toml`, added in commit [`da0b35dc419b90cf35a97703b0478cf35cc3a462`](https://github.com/StellarCanary/ProtocolCanary-Fixtures/commit/da0b35dc419b90cf35a97703b0478cf35cc3a462). Its Soroban argument list uses `kind = "i128"`. Engine `v0.1.1` at `919668859bc1bef3d58737f13695b486d67632ea` and `v0.2.0` at `7e1eb63dd63be6aefcb9d248ae80afc66436c4c6` do not accept `i128` in Soroban fixture arguments. Both parsers list the supported kinds without `i128`. Engine main added `i128` parsing in commit [`475fdcf65eaea3e4dd7effc57a600e461ae451d8`](https://github.com/StellarCanary/Protocol-Canary/commit/475fdcf65eaea3e4dd7effc57a600e461ae451d8).

This is a real historical Engine limitation and a fixture-contract version mismatch when those older releases are paired with Fixtures `main`. It is not a runner outage, and the fixture is valid for the newer Engine that implements its declared argument kind. The immutable `protocol-28` tag predates this fixture. The canonical fixture has not been changed. The current offline-XDR matrix disables Soroban, so it does not test this Soroban limitation. The earlier run's parser diagnostics are preserved as evidence; no expectation was added to turn the result green.

Fixtures `main` also contains the XDR fixture `p28-xdr-ledger-entry-account-truncated.toml`, added in Fixtures commit [`0831377d49fa61ef58d354ababeae6fab26660f6`](https://github.com/StellarCanary/ProtocolCanary-Fixtures/commit/0831377d49fa61ef58d354ababeae6fab26660f6) on 2026-10-22. Engine main added `LedgerEntry` XDR support in commit [`695080be77cc06077393a305a6f5a5b346847525`](https://github.com/StellarCanary/Protocol-Canary/commit/695080be77cc06077393a305a6f5a5b346847525) on 2026-10-15, after the `v0.1.1` and `v0.2.0` release commits. In run [41452363927](https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/41452363927), both releases built successfully, then rejected this fixture before running checks with `unsupported XDR type name "LedgerEntry"`. This is a verified historical Engine limitation for the moving `main` pack, not infrastructure failure. The fixture is unchanged. Two exact `execution-failed` expectations record these observed Engine/Fixtures ref pairs and their diagnostic signature; if either pair stops producing that diagnostic, it will classify as an unexpected pass or failure and require review.

## Classifications

Each cell receives one classification:

| Classification | Meaning | Workflow effect |
|---|---|---|
| `supported` | A valid CLI report says `pass` and contains at least one executed check. In this workflow, that means the enabled offline XDR checks passed. | Does not fail the workflow. |
| `expected-incompatible` | An observed CLI failure matches an expectation entry for the exact Engine ref, Fixtures ref, status, and diagnostic signature. | Does not fail the workflow; the limitation remains visible in the report. |
| `infrastructure` | A ref checkout or build failed, the check timed out or was cancelled, or the evidence could not be validated. A report-less network/transport error is infrastructure. | Fails the workflow. |
| `skipped` | A valid report shows zero checks ran. A zero-check cell is never supported. | Does not fail the workflow. |
| `unexpected-failure` | A valid report failed without a matching expectation, or the raw CLI evidence identifies a deterministic fixture parse error without a matching expectation. | Fails the workflow. |
| `unexpected-pass` | A valid report passed for a pair that has an expectation. | Fails the workflow. |

A deterministic fixture parse error such as `unsupported arg kind "i128"` or `unsupported XDR type name "LedgerEntry"` is not classified as infrastructure. The classifier recognizes it only when the raw stderr, nonzero CLI exit code, and missing usable report agree. The artifact retains the report file, stderr, exit code, build stdout and build stderr. The collector rechecks that the reported failure kind matches those raw files. Other missing or malformed report evidence remains infrastructure because compatibility cannot be determined from it.

The expectation registry is `docs/compat-expectations.json`. Entries require observed refs, status, diagnostic signature, run URL, date and reason. Its two current entries cover only the observed `LedgerEntry` parser rejection for `v0.1.1`/`main` and `v0.2.0`/`main`, backed by run [41452363927](https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/41452363927). Do not add an expectation merely to make a run green.

## Failure and collection behavior

Matrix cells run independently with fail-fast disabled. The collector runs with `always()` after both preparation and matrix jobs, including when a matrix cell fails. It classifies every expected cell, records workflow-level problems such as missing artifacts, and writes `TABLE` and `HAS_FAILURES` to `GITHUB_OUTPUT`. The job summary prints the classification table. Infrastructure failures, unexpected failures, unexpected passes, and collection issues fail the workflow. Expected incompatibilities and skipped cells remain visible but do not fail it.

## Artifacts

Each cell uploads a unique `cell-facts-<cellId>` artifact. It contains `cell-facts.json` and the raw files produced by the build and CLI check. The facts record:

- Engine ref and resolved commit, Fixtures ref and resolved commit, and Action commit;
- the `offline-xdr` execution mode;
- checkout, build and CLI outcomes, including the CLI exit code;
- validated CLI status and counts when a valid report exists;
- the first diagnostic, any report error, the CLI failure kind, and the exact evidence file names.

The collector downloads and validates each cell artifact against the prepared matrix, the recorded refs and commits, the expected files, and the actual CLI evidence. Missing, duplicate, mismatched or malformed artifacts cannot produce a successful empty report.

The collector uploads `compat-matrix.json`, a machine-readable object containing `schemaVersion`, `actionCommit`, `runUrl`, `executionMode`, `expectedCellCount`, `cells`, `issues`, `hasFailures`, and the Markdown `table`. Each cell contains its refs, classification, reason, evidence URL, and validated `facts` (or `null` when facts could not be read). Cell artifacts and the classification report are retained for 14 days. The job summary contains the human-readable table.

## Engine binary version support

The table below summarises which engine releases the matrix has successfully
built and checked, the minimum Action version required to use each, and the
supported protocol targets. Cells marked **not tested** are outside the matrix's
current scope; see [`docs/releases.md`](releases.md) for the per-release run
record.

| Engine version | Supported protocols | Minimum Action version | Notes |
|---|---|---|---|
| `v0.1.1` | 28 | v1 | Protocol 28 offline XDR only. Rejects `LedgerEntry` and `i128` fixtures absent from the `protocol-28` tag. See [verified compatibility limits](#verified-compatibility-limits). |
| `v0.2.0` | 28 | v1 | Protocol 28 offline XDR only. Same `LedgerEntry` / `i128` limits as `v0.1.1`. Adds optional `source` field to results and a result cache. `--allow-empty` required for no-fixture invocations. |
| `main` (HEAD) | 28, 29 | v1 | Adds `LedgerEntry` and `i128` support; tested against Fixtures `main`. Live protocol 29 tested separately via `weekly-live.yml`. Not a release; use a pinned commit sha. |

### CLI flag changes between engine releases

The table below documents CLI flags whose syntax or semantics changed across
major and minor engine releases. Flags absent from a row were not changed in
that release.

| Flag | `v0.1.1` | `v0.2.0` | Notes |
|---|---|---|---|
| _(no-fixture invocation)_ | Exits `0` with an empty report when no fixture applies. | Exits `2`; use `--allow-empty` to restore the old exit code. | The Action does not forward `--allow-empty` today (see [engine-0.2.0-compatibility-plan.md](engine-0.2.0-compatibility-plan.md)). |
| _(symlinked fixture dirs)_ | Accepted. | Rejected; exits `4`. | Affects any fixture directory containing symbolic links, junctions, or unsafe payload paths. |
| _(unknown config key)_ | Accepted with a warning (or silently). | Rejected; exits `2`. | A `.stellar-canary.toml` with an unknown section or key is now a hard error. |
| `--json` / result cache | Not present. | Results cached in `.stellar-canary-cache/`; results gain an optional `source` field. | Cache is opt-in by default; the `source` field is additive and the Action reads it defensively. |

The minimum Action version column in the engine table reflects the oldest
`action.yml` that correctly maps each exit code. If you consume this Action via
the `@v1` floating tag, you automatically receive the latest mapping. If you pin
by commit sha, verify the mapping table in `action.yml` covers the exit codes of
the engine version you use.

## Regression tests

`tests/unit/compat-matrix-inputs.test.ts` covers ref splitting and validation. `tests/unit/compat-matrix-results.test.ts` covers fact creation, raw artifact validation, report-less Soroban and XDR fixture parse errors, transport failures, and collection. `tests/unit/classify-compat.test.ts` covers classification boundaries and workflow failure behavior.
