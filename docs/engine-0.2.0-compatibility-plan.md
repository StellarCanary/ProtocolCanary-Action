# Plan: Protocol-Canary 0.2.0 and this Action

Status: proposal for maintainer review. Nothing in this plan has been applied.
The Action's `version` default stays `0.1.1`, the floating `v1` tag is untouched,
and no Action release is proposed by this document.

## Why this needs a plan

Protocol-Canary 0.2.0 (prepared, not yet published) changes the outcome of
invocations that worked before:

- `check` exits `2` and prints no report when no fixture applies, instead of
  passing. `--allow-empty` restores the old exit code.
- Fixture directories containing symbolic links, junctions or unsafe payload
  paths are rejected (exit `4`).
- `.stellar-canary.toml` with an unknown section or key is rejected (exit `2`).
- `check` keeps a result cache in `.stellar-canary-cache/` and JSON results gain
  an optional `source` field.

Because `@v1` is a floating tag and `version` has a default, changing the default
engine silently switches every `@v1` user to this behavior. This plan avoids that.

## What was verified (2026-10-09)

Run locally, with this repository's `dist/index.js` at `def0e8a` and an engine
built from the 0.2.0 release-preparation branch, installed in a temporary
`CARGO_HOME` so the Action's "use the installed matching binary" path ran. No
network access beyond the Action's own GitHub API call, no credentials.

| Case | Result |
|---|---|
| `version: 0.2.0`, Protocol 28 pack, offline config | job passes, `status=pass`, 4 checks passed, report path output set |
| `version: 0.2.0`, `protocol: 29` against the Protocol 28 pack | job fails as an execution failure; summary contains the engine's `no checks ran: ...` text |
| Same case, annotation text | reads "Canary configuration is invalid. (exit code 2)" and omits the engine's reason (tracked as an issue draft) |
| `version` input accepts `0.2.0` | yes, no Action change is needed to opt in |

Not verified: an install through `cargo install --git ... --tag v0.2.0`, because
the tag does not exist. That check belongs after publication.

## Update after publication (2026-10-20)

The tags now exist and the post-publication check has been attempted and
recorded in [`docs/releases.md`](releases.md) (issue #439). Summary of
what changed in that record, with no plan decision edited:

- The verification now covered by runs, all evidence in `docs/releases.md`:
  engines built from source at `v0.2.0` and `v0.1.1` pass this repository's
  real-engine suite (the pinned engine-compat job), and the new
  exit-code/skip suite (issue #438) passes against a real 0.2.0 engine.
- The **install through `cargo install ... --tag v0.2.0` step of sequence
  step 2 is still NOT recorded as passing**, and 0.2.0 is therefore NOT
  added to the README compatibility table: every consumer-style run
  (`uses: ./`) fails to load the Action itself before any install is
  attempted, because the `github-token` input in `action.yml` uses
  `${{ github.token }}`, an expression context action-metadata input
  defaults do not allow. Run URLs and the exact runner errors are in
  `docs/releases.md`; the one-line metadata fix belongs in its own PR,
  after which those runs should be repeated and the table updated together
  (never a first-row claim without a recorded passing run).
- Step 3 items are unaffected. Step 4 remains a separate maintainer decision.

## Proposed sequence

1. **Do nothing to defaults.** Users who want 0.2.0 set `version: 0.2.0`. Add a
   row to the compatibility table only after step 2 has passed.
2. **After the engine release is published,** run the Action from `main` with
   `version: 0.2.0` through `cargo install --git ... --tag v0.2.0 --locked`
   against the Fixtures `protocol-28` tag (offline job) in a scratch repository
   or a dispatched workflow. Record the run URL. Also run it with `0.1.1` to
   confirm nothing regressed.
3. **Small Action changes that make 0.2.0 usable** (separate pull requests, each
   tested with the mock engine): show the engine's reason in the failure
   annotation and fix the exit-2 description; an `allow-empty` input accepted
   only when the resolved engine is 0.2.0 or newer; display replayed-result
   counts.
4. **Decide the default separately.** Moving the default to 0.2.0 turns
   previously passing `@v1` runs into failures. Recommended: do it only in a new
   major tag (`v2`) with a migration note, leaving `v1` on `0.1.1`. This is a
   maintainer decision; it is not made here.
5. **Update the compatibility table** in the README and `docs/releases.md` with
   exactly the combinations that were run in step 2, and nothing else.

## Risks to watch

- The weekly live integration job (formerly `integration.yml`, now
  `weekly-live.yml`) initially failed after Testnet moved to protocol 29
  (issue #352, repaired there). It now uses the separately pinned Protocol 29
  Fixtures release. The Protocol 28 fixtures in step 2 above apply only to
  that offline compatibility run; they do not predict the weekly live result.
  Record a live result from the weekly workflow itself rather than inferring
  compatibility from the offline Protocol 28 run.
- Anyone running a "no fixtures" step on purpose (for example to test their
  workflow wiring) needs `--allow-empty`, which the Action cannot pass today.
- A checksum published beside an engine asset protects against corruption, not
  against a compromised release; this Action does not verify signatures because
  none exist.

## Report schema field differences between v0.1 and v0.2

This section documents the differences in report structure between engine
v0.1.x and v0.2.0, as recorded in
`tests/fixtures/report-schema-divergences.json` and reflected in
`src/output.ts` (`parseReport`). The Action's `parseReport` function is the
authoritative consumer; this section explains its tolerances and rejections
for cross-version compatibility.

### Top-level field changes

| Field | v0.1.x behaviour | v0.2.0 behaviour | Action handling |
|---|---|---|---|
| `counts` | Present and matches the JSON Schema's required shape. | May be missing or have missing/non-numeric members. | Tolerated: the Action re-derives all counts from `results` and `skipped`, so a missing or malformed `counts` object is never a rejection reason (divergences `del:counts`, `del:counts.member`, `type:counts`, `type:counts.member`). |
| `network` | Object or absent. | May be explicit `null` for offline runs. | Tolerated: `network: null` is treated the same as an absent `network` field — an offline run, never an error (divergence `type:network-null`). |
| `results[i].source` | Field absent. | Optional string indicating how the result was obtained (live or replayed from cache). | The Action reads `source` defensively and treats unknown or missing values as "not live", so a wrong-typed value cannot fake compatibility evidence (divergence `type:results[i].source`). |
| `run.toolBuildCommit` | May be absent. | Present when the engine records its own build commit. | The Action does not validate the `run` object; this field is copied defensively into the Execution Receipt as `engineCommit` (divergence `del:run.toolBuildCommit`). |
| `verbose` | May be absent. | Optional boolean. | Informational metadata the Action never reads (divergence `type:verbose`). |

### Deprecated summary properties

The JSON Schema marks `counts` as required, but the Action no longer enforces
its presence. As of this plan, `counts` is treated as a deprecated convenience
field: the Action computes all counts from the actual `results` and `skipped`
arrays, which are the authoritative source. Consumers that read `counts`
directly should migrate to computing them from `results` and `skipped`.

No `counts` member is deprecated individually — the whole object is optional
and re-derived if present and inconsistent. A report whose recorded `counts`
disagree with what `results`/`skipped` actually contain is **rejected** by the
Action (`probe:counts-disagree`), because doctored or truncated counts could
mask a failure.

### Fallback behaviour when reading reports across versions

The Action applies the following fallbacks when it encounters a report from an
engine version that predates a field:

1. **`counts` absent or malformed** — Re-derived from `results` and `skipped`.
   The report is not rejected unless the re-derived counts disagree with
   explicitly recorded counts.
2. **`network: null`** — Treated as an offline run; `observedProtocol` is set
   to `"unknown"` in the receipt.
3. **`results[i].source` absent or wrong type** — Treated as `"not live"`.
   The result's compatibility verdict is unaffected.
4. **`run.toolBuildCommit` absent** — `engineCommit` in the receipt falls back
   to the future `engineCommit` top-level field, then to `"unknown"`.
5. **`fixturePack.digest` absent** — `packDigest` in the receipt falls back to
   the future `packDigest` top-level field, then to `"unknown"`.
6. **`project.type` outside the controlled vocabulary** — Accepted as opaque
   text per CF-01; the Action only requires it to be a non-empty string.
7. **`results[i].protocol` or `results[i].durationMs` non-integer or below
   schema minimum** — Accepted; both fields are informational and are never
   used to compute a compatibility verdict.

Fields that are **always required** regardless of engine version:
`toolVersion` (non-empty string), `project.name` (non-empty string),
`results[i].fixtureId` (string or explicit `null`),
`network.name` when `network` is non-null (non-empty string). Any report
missing these is rejected regardless of the engine version that produced it.

## Protocol 29 live workflow prerequisite (2026-11-03)

The weekly workflow now pins Fixtures release
[`fixtures-p29-v0.1.1`](https://github.com/StellarCanary/ProtocolCanary-Fixtures/releases/tag/fixtures-p29-v0.1.1)
at commit `347ad6846d46b7bdf605a299501354563d79f2d9`. Its only RPC fixture
uses `get-version-info`. A manual run from Action PR #552 confirmed the
published Engine `v0.2.0` rejects that method before sending an RPC request;
the run executed zero checks and did not verify endpoint availability.

Engine `main` supports the method. [Engine PR #626](https://github.com/StellarCanary/Protocol-Canary/pull/626)
prepares release `v0.3.0`, and the weekly workflow explicitly pins that version.
Merge and publish the Engine release before merging the Action pin. Then run
the weekly workflow manually on Testnet and Futurenet and record the result;
Protocol 28 offline compatibility results do not validate this live path.
