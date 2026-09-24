# Security Policy

## Scope

This policy covers `StellarCanary/ProtocolCanary-Action`, the GitHub
Actions integration layer. It does not cover the separate
`StellarCanary/Protocol-Canary` (the compatibility engine) or
`StellarCanary/ProtocolCanary-Fixtures` (the fixture corpus) repositories,
which have their own security policies.

## What this Action never does

- **No private keys, seed phrases, or signing authority.** This Action
  never asks for, stores, or transmits one. Neither does the CLI it
  wraps — see `Protocol-Canary`'s own `SECURITY.md`.
- **No transaction submission.** Only read operations and Soroban
  *simulation* happen anywhere in this pipeline.
- **No Docker, no paid infrastructure, no database, no hosted backend.**
  The Action runs entirely inside the GitHub Actions runner.

## Minimum GitHub permissions

Ordinary compatibility testing needs only:

```yaml
permissions:
  contents: read
```

The Action does not call the GitHub API on your repository at all for its
core function. It does call the public GitHub REST API for
`StellarCanary/Protocol-Canary` itself — to resolve a release tag to a
commit and to look for a published checksum manifest (see
[Installation integrity](#installation-integrity)). When the workflow makes
`secrets.GITHUB_TOKEN` available in the environment, those reads are
authenticated with it, which only raises the GitHub API rate limit (60 to
1,000+ requests/hour, important because GitHub-hosted runners share source
IPs); when no token is available they fall back to unauthenticated reads.
No token is required for the core function, and this Action never reads or
writes *your* repository through the API. Future features that need PR
comments or check runs will document their own, separately scoped,
permission requirements rather than making write access a default
requirement.

## Installation integrity

`Protocol-Canary` does not yet publish signed release binaries or
checksums. This Action installs it from source with `cargo install --git`,
which:

- always uses HTTPS to reach GitHub;
- pins the exact requested version (the `version` input) — never `main`,
  never an unpinned "latest";
- resolves that version's tag to the immutable commit it pointed to at run
  time via the GitHub REST API, and pins `cargo install --rev` to that
  commit — stronger than pinning the (mutable) tag alone;
- falls back to pinning the tag directly, with a visible warning, only if
  that resolution fails (for example, a transient GitHub API error) —
  this Action never silently falls back to an unpinned or different
  version;
- uses `--locked`, so the exact dependency versions in `Protocol-Canary`'s
  own committed `Cargo.lock` are used rather than whatever the latest
  compatible versions happen to be at build time;
- never executes a downloaded script — the toolchain performing the build
  is `cargo`, already present on the runner, not something this Action
  fetches and runs;
- verifies the installed or cached binary against the checksum manifest
  published with the release, when one exists, and refuses to use a binary
  that does not match (see [Checksum verification](#checksum-verification)).

### Checksum verification

When the requested `Protocol-Canary` release publishes a checksum manifest
(for example `SHA256SUMS`) as a release asset, this Action downloads it,
hashes the binary it is about to run, and compares the two. A mismatch
throws an `InstallationFailed` error and the binary is never executed.

`Protocol-Canary` does not publish checksums yet, so the lookup normally
finds nothing and this step is a no-op that logs a debug line. That
fallback to commit/tag pinning is deliberate and is the documented,
unchanged behavior: the checksum step only ever *adds* a guarantee when a
manifest exists, and its absence never weakens the existing pinning.
A compiled-from-a-pinned-commit build is still a weaker integrity story
than a checksum published by the artifact's own maintainers, so making
checksum-verified installs the primary path remains the goal.

## Subprocess isolation

Pull request source code is treated as untrusted. This Action:

- never executes a shell string built from fixture data, repository
  configuration, PR body/title, issue text, or commit messages;
- always passes arguments to the Canary process as an array
  (`child_process.spawn(binary, [...args])`), never through a shell —
  see `src/runner.ts`;
- enforces a configurable timeout and forwards workflow cancellation
  signals to the child process, so a hung or malicious process cannot
  outlive the job.

## Secret handling

This Action never dumps the process environment and never prints a GitHub
token. When `GITHUB_TOKEN` is present it is used only as a bearer
credential for read-only requests to the public
`StellarCanary/Protocol-Canary` API, and is never echoed to logs,
outputs, or the job summary. The Action does not require any secret for
its core function. If a
workflow's `rpc-url` happens to embed a credential in its query string
(not a pattern this project recommends), that is echoed only insofar as
Canary itself might log it — the same as any other CLI argument a workflow
author chooses to pass.

## Supported versions

Only the latest released `0.x` minor version of this Action receives
security fixes while it is pre-1.0.

## Audit status

No formal third-party security audit has been performed on this
repository. Confidence in the claims above comes from the implementation
(argument-array subprocess execution, no shell interpolation, pinned
commit installation) and its test suite, not from an external review.

## Reporting a vulnerability

Please open a private report via GitHub's "Report a vulnerability" feature
on this repository, or contact the maintainers directly, rather than
filing a public issue. Include:

- a description of the issue and its impact;
- steps to reproduce;
- the affected version or commit.

We will acknowledge reports and work with you on a fix and disclosure
timeline before any public write-up.
