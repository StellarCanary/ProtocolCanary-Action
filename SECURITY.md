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
core function (it does call the public, unauthenticated GitHub REST API
for `StellarCanary/Protocol-Canary` itself, to resolve a release tag to a
commit — see [Installation integrity](#installation-integrity)). Future
features that need PR comments or check runs will document their own,
separately scoped, permission requirements rather than making write access
a default requirement.

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
  fetches and runs.

If `Protocol-Canary` begins publishing checksummed release artifacts, this
Action should move to verifying those directly, since a compiled-from-a
-pinned-commit build is a weaker integrity story than a checksum published
by the artifact's own maintainers.

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
token. It does not require any secret for its core function. If a
workflow's `rpc-url` happens to embed a credential in its query string
(not a pattern this project recommends), that is echoed only insofar as
Canary itself might log it — the same as any other CLI argument a workflow
author chooses to pass.

## Supported versions

Only the latest released `0.x` minor version of this Action receives
security fixes while it is pre-1.0.

## Reporting a vulnerability

Please open a private report via GitHub's "Report a vulnerability" feature
on this repository, or contact the maintainers directly, rather than
filing a public issue. Include:

- a description of the issue and its impact;
- steps to reproduce;
- the affected version or commit.

We will acknowledge reports and work with you on a fix and disclosure
timeline before any public write-up.
