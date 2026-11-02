# Integrity Model, Guarantees, and Trust Boundaries

This document describes the complete security model of the Stellar Protocol
Canary Action: the trust boundaries code actually enforces today, the
integrity guarantees it does and does not make, and the two open decisions
(D-07 and D-11) that bound those guarantees. It complements
[`SECURITY.md`](../SECURITY.md), which states the policy; this document
explains the model behind it and where each claim lives in the
implementation. The fork-PR *threat* model authored alongside it
(permissions scoping and boundary conformance, issue #369) will be
maintained by the sibling document `docs/security-model.md` (currently on
open PR #461) — these two documents cover different axes and are meant to
be read together.

## Trust boundaries

A "trust boundary" is a point where data or control crosses from a less
trusted context to a more trusted one. This Action has five:

| # | Boundary | Crosses | Enforced by |
|---|---|---|---|
| 1 | Workflow author → Action | Action inputs (`action.yml`) | `src/inputs.ts` validation: strict boolean literals, integer formats, `https://`-only `rpc-url` (localhost exempt), `config` must be an existing regular file resolved before forwarding |
| 2 | GitHub REST API → Action | Release tag/commit resolution, checksum manifests | `src/canary.ts` + `src/version.ts`: HTTPS-only requests, no redirect following, non-200 is an error, malformed JSON/manifests are "unverifiable", never "verified" |
| 3 | Installed binary → executed binary | Source build or downloaded release binary, with recorded origin | Source builds use the resolved commit/tag pin and an install-time digest; downloaded release binaries require the exact asset checksum. Strict mode rejects source builds (see below). |
| 4 | Engine output → reporting layer | Canary stdout JSON, stderr | `src/output.ts` schema-validated parsing; `src/summary.ts` fences external diagnostics against markdown injection; `src/redact.ts` neutralises workflow-command sequences |
| 5 | Action → runner OS | Every process launch | `src/runner.ts`: argument arrays only, never a shell string; bounded timeout; SIGTERM/SIGKILL escalation |

Pull-request source code is untrusted at every boundary; nothing in fixture
data, PR text, or engine output is ever interpolated into a shell command
(`runs-on` workflows see [`docs/reusable-workflow.md`](reusable-workflow.md)
for the least-privilege consumption pattern).

## Integrity guarantees — and their honest limits

**What is guaranteed today:**

- The engine version is pinned to an immutable commit resolved from the
  requested release tag wherever possible.
- Source-built binaries are never compared with published release
  checksums. The Action performs no manifest lookup for that origin and
  explains the commit/tag guarantee at info level. Source builds saved to
  the Actions cache retain an install-time digest; restoration checks that
  digest and restores the source-build origin before reuse.
- Downloaded release binaries require an exact match between the requested
  platform asset name and the checksum manifest entry. Engine v0.2.0
  publishes `stellar-canary-linux-x86_64`; neither a generic binary name nor
  an entry for another platform can substitute for it. Path-prefixed names
  are not reduced to their basename. A missing exact entry, unavailable
  manifest, or digest mismatch aborts (`InstallationFailed`) before the
  downloaded binary runs, in both default and strict modes.
- The release-asset downloader makes one HTTPS request to a `github.com`
  release URL. Any 3xx is rejected before `Location` is parsed or requested.
  It removes partial files, and the Engine installer logs its permitted
  source-build fallback. Fixture-pack downloads fail closed.
- Asset requests carry no Authorization header. Runtime request helpers add a
  bearer token only to a clean absolute HTTPS URL for exact `api.github.com`.
  They reject userinfo, encoded authorities, non-default ports, HTTP, and
  malformed URLs before opening a request. Release assets and every other
  host receive no token.

**What is deliberately *not* guaranteed (decision D-07, deferred):**
checksums and commit pins are data-integrity mechanisms — they detect
accidental corruption and post-publication substitution of an artifact.
They are not proof of the release author's identity, authenticity, or
endorsement, because `Protocol-Canary` publishes no signatures (no GPG or
minisign identities, no Sigstore bundles). A checksum manifest published
*by GitHub alongside a release* is only as trusted as the release itself.
Any digest shown in the job summary's "Provenance & Trust" section carries
this caveat inline; it must never be quoted as authorship proof.

**Decision D-11 (unresolved, blocked):** runtime redirect following remains
disabled. The pure candidate policy in `src/download-policy.ts` allows only
the observed `github.com` → `release-assets.githubusercontent.com` edge,
validates both URLs, and caps a proposed chain at three hops. It is not
imported by runtime code and does not approve redirects. The Action observed
the source's 302 and destination hostname on 2026-11-02 without following
the redirect; the Engine contract records an earlier 200 response from the
destination. Maintainers must review this evidence and explicitly approve
the exact rule before runtime integration. Any later CDN hostname needs new
evidence and approval.

## The strict-integrity fail-closed policy (issue #372)

The optional `strict-integrity` input (default `false`) rejects source-built
binaries, including restored source builds. Those binaries have no
applicable published release checksum, so strict mode must fail closed with an
`InstallationFailed` error before executing them. It does not try to use a
checksum from a different build to establish integrity.

Downloaded release binaries must pass published checksum verification in
both modes. A missing manifest, a missing exact platform asset entry, a
failed lookup, or a mismatched digest aborts before the downloaded binary
executes. If no usable prebuilt candidate exists before download, the Action
may fall back to a source build; strict mode rejects that source build.

| Condition | `strict-integrity: false` (default) | `strict-integrity: true` |
|---|---|---|
| Source build, including cache restoration | proceed on commit/tag pinning and install-time digest, info log | abort without a release checksum lookup |
| Release binary matches its exact asset checksum | proceed, digest in summary | proceed, digest in summary |
| Release binary checksum mismatch | abort | abort |
| Release verification has no manifest | abort | abort |
| Release verification has no exact asset entry | abort | abort |
| Release manifest lookup redirected / non-HTTPS | abort | abort |

Strict mode raises the integrity bar only as high as D-07 allows: it
proves the artifact matches what its release published, not who published
it.

## Provenance & Trust summary section (issue #373)

`src/summary.ts` renders a per-run table with the executed engine's
version, the SHA-256 computed directly from the executed binary,
and the fixture-pack digest once the download pipeline
(#338) produces one. Metadata a run does not actually have is rendered as
explicitly *unverified*, never omitted and never fabricated, and the
section always carries the D-07/D-11 caveat so a summary screenshot cannot
be read out of context.

## Least-privilege permissions and the fork PR trust boundary (issue #369)

The Action's core function needs `permissions: contents: read` and
nothing else — no write token scope is ever required, `GITHUB_TOKEN` is
used only opportunistically for rate limiting, and the reusable workflow
([`docs/reusable-workflow.md`](reusable-workflow.md)) documents the
`pull_request` target model in which fork PRs run with a read-only token
and no secrets. The detailed fork-PR threat analysis and the conformance
tests live with the sibling `docs/security-model.md` line of work (#461);
this document owns the integrity axis: what the Action trusts about the
binary it runs and the channels it verifies it over.

## Threat model

| Threat | Vector | Status in this Action |
|---|---|---|
| Tampered release artifact | Substituted binary after publication | Checksum mismatch aborts before execution and before cache save (`src/canary.ts`) |
| Cache poisoning | Malicious entry under a predictable Actions cache key | Cache key embeds platform, arch, and the immutable commit (`stellar-canary-<platform>-<arch>-<sha>`); restored binaries are re-verified; a verification failure never saves |
| Redirect to attacker host | 3xx response during release asset download | Never followed while D-11 is blocked; Engine installation warns and may use the pinned source build under default integrity, while fixture-pack download fails closed |
| Downgrade to plaintext | `http://` asset URL | Unconditionally rejected — TLS client only, no second request |
| Shell injection via inputs or engine output | Argument interpolation, fixture/PR text | Array-spawn only, no shell; inputs validated at boundary 1 |
| Markdown / workflow-command injection via engine stderr | Diagnostic text in summary or logs | Fenced with CommonMark-longer fences (`src/summary.ts`) and neutralised (`src/redact.ts`) |
| Compromised release author account | Attacker with repo publish rights edits tag/assets | **Open residual risk (D-07):** no signatures exist; commit pinning narrows but does not close this; tag re-pointing is resisted by commit resolution |
| Moving-reference tracking | `latest`/`main` pinning | Rejected at input validation for both engine and pack version inputs |

## Open items

- D-07: release signing deferred upstream; until then nothing in this
  repository may present a checksum as authenticity.
- D-11: redirect allowlist / hop budget / header policy is blocked. The
  candidate module is tested but not wired into runtime; maintainers still
  need to approve the observed host pair and proposed behavior.
- #338: fixture-pack download with redirect and size limits — the pack
  digest row in the summary stays "unverified" until this lands.
- #360: execution receipt serialization (open PR) will feed additional
  per-run provenance into the same summary section.

## References

- [`SECURITY.md`](../SECURITY.md) — policy statements this model implements.
- [`action.yml`](../action.yml) — the `strict-integrity` input contract.
- [`docs/contracts.md`](contracts.md) — cross-repository contracts,
  including CF-06 (fixture releases).
- [`docs/reusable-workflow.md`](reusable-workflow.md) — least-privilege
  consumption of the maintained reusable workflow.
- `tests/unit/integrity.test.ts`, `tests/unit/strict-integrity.test.ts` —
  executable statements of these boundaries.
