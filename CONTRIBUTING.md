# Contributing

## Development setup

Node 24. The root [`.nvmrc`](.nvmrc) pins it (`nvm use`), matching the
`node24` Actions runtime the Action declares in `action.yml` and the
`node-version: 24` CI uses. `package.json` keeps a looser floor
(`engines.node >= 20`); any supported Node 20+ can run the tests, but new
code and local setup should target 24. npm is the package manager; the
lockfile (`package-lock.json`) is committed and authoritative.

Three command-line tools must also be on `PATH`: `bash`, `jq`, and
`python3`. The reusable-workflow conformance tests
(`tests/unit/reusable-workflow-conformance.test.ts`) execute the shipped
step scripts with `bash`, parse the GitHub artifacts listing with `jq`,
and build and unpack the zip fixtures with `python3`. GitHub-hosted
runners ship all three. When one is missing on a local machine, exactly
the tests that need it are skipped with a message naming the tool; when
one is missing in CI (the `CI` environment variable is set), that test
file fails with a single error naming it instead, so a runner image that
loses a tool can never silently skip the conformance tests.

```bash
npm ci
npm run audit
npm run check:licenses
npm run typecheck
npm run lint
npm test
npm run build
```

All must pass before a change is considered done — this is exactly
what `.github/workflows/ci.yml` runs, plus a check that the committed
`dist/` matches a fresh build (see [Build](#build) below).

## Repository structure

| Path | Responsibility |
|---|---|
| `.nvmrc` | Pins the local Node version to the `node24` runtime CI and `action.yml` use. |
| `src/main.ts` | Orchestrates a run; the only file with `if (require.main === module)`. |
| `src/inputs.ts` | Reads and validates every Action input. |
| `src/canary.ts` | Resolves/installs the `stellar-canary` binary. |
| `src/runner.ts` | Builds CLI args; spawns and supervises the Canary process. |
| `src/output.ts` | The JSON report type and exit-code table (the CLI's documented contract). |
| `src/summary.ts` | Renders the GitHub job summary. |
| `src/annotations.ts` | Converts results into GitHub annotations. |
| `src/artifact.ts` | Uploads the JSON report as a workflow artifact. |
| `src/errors.ts` | Typed internal error classes. |
| `src/version.ts` | Resolves a requested version to a pinned commit. |
| `tests/unit/` | Vitest unit tests, generally one `*.test.ts` per `src/` module (matched by name), exercising it in isolation with `child_process`, `@actions/*`, and network calls stubbed. |
| `tests/integration/` | End-to-end tests that run the whole Action (`src/main.ts`) against the mock CLI and assert the outputs, summary, annotations, and pass/fail behavior. |
| `tests/fixtures/mock-canary.cjs` | The fake `stellar-canary` CLI every test runs in place of the real binary; it selects a result state via `MOCK_CANARY_SCENARIO` (see [Test commands](#test-commands)). |

Each file has one responsibility; `main.ts` is the only place that wires
them together and decides pass/fail. `vitest.config.ts` collects both
`tests/unit/**/*.test.ts` and `tests/integration/**/*.test.ts`, so new tests
belong in one of those two directories. See [`docs/` in
`Protocol-Canary`](https://github.com/StellarCanary/Protocol-Canary/tree/main/docs)
for the CLI/JSON contract this Action consumes — that document, not this
repository, is the source of truth for the CLI's behavior.

## Test commands

```bash
npm run typecheck    # tsc --noEmit, strict mode
npm run lint         # eslint
npm test             # vitest run (unit + integration, includes workflow-policy.test.ts)
npm run test:coverage  # vitest run with v8 coverage over src/ (text, HTML, and lcov reports in coverage/)
npm run audit        # npm audit --omit=dev --audit-level=high
npm run check:licenses # license allow-list verification for production dependencies
npm run build         # esbuild bundle to dist/index.js
actionlint           # static analysis of .github/workflows/
zizmor .github/workflows # security audit of .github/workflows/
```

### Updating job summary goldens

The job summary's exact Markdown output is stored in `tests/golden/` and
checked by `tests/unit/summary-golden.test.ts`. To intentionally update the
snapshots, run:

```bash
UPDATE_GOLDEN=1 npx vitest run tests/unit/summary-golden.test.ts
```

Review every changed golden file by hand. A pull request that changes a
golden must explain why the summary format changed; do not update snapshots
just to make a failing test pass.

### Trying the Action locally without GitHub

To see what a change does end to end without pushing a branch, run the
committed bundle the way a workflow run would:

```bash
npm run build
node scripts/run-local.mjs \
  --engine "$HOME/.cargo/bin/stellar-canary" \
  --fixtures-dir ./my-fixtures \
  --protocol 28 \
  --input version=0.1.1 \
  --input allow-empty=true
```

`scripts/run-local.mjs` builds the runner environment the Action reads
(`INPUT_*` from `--input name=value`, plus `GITHUB_OUTPUT`,
`GITHUB_STEP_SUMMARY`, `GITHUB_ENV`, `RUNNER_TEMP` and a temporary
`CARGO_HOME` holding the engine given by `--engine`) in a temporary
directory, runs `dist/index.js`, and prints the outputs the Action wrote,
the rendered job summary, the `::`-annotation lines it emitted, and the exit
code — then exits with that code and removes the temporary directory. It
never installs an engine (`--engine` is required) and never talks to the
network. `--help` documents every option; see `tests/unit/run-local.test.ts`
for the exact contract.

`npm run test:coverage` runs the same suite as `npm test` with coverage
measurement enabled (via `@vitest/coverage-v8`; configured in
`vitest.config.ts` to measure `src/` only). It reports line/branch coverage
per source file in the terminal, and writes HTML and lcov reports to
`coverage/` (gitignored).

CI enforces coverage thresholds on Ubuntu pull requests and main pushes. New
code must not lower test coverage below these minimums:

- Statements: 91%
- Branches: 84%
- Functions: 95%
- Lines: 91%

These thresholds live in `vitest.config.ts` under `test.coverage.thresholds`
and are set slightly below current baseline measurements to accommodate
refactoring while preventing regressions. As test coverage increases across
the codebase, these thresholds are ratcheted upward. Run `npm run test:coverage`
locally to verify your changes satisfy the coverage gate.

Unit and integration tests must never require network access or a real
`stellar-canary` binary by default: they run against
[`tests/fixtures/mock-canary.cjs`](tests/fixtures/mock-canary.cjs), a fake
CLI that simulates every documented result state (`pass`, `warning`,
`fail`, `config-error`, `rpc-error`, `fixture-error`, `internal-error`,
`malformed-json`, `timeout`) via the `MOCK_CANARY_SCENARIO` environment
variable. Real-engine checks run separately: `.github/workflows/weekly-live.yml`
runs on a weekly schedule or manual dispatch against a real Canary build and
live Testnet/Futurenet endpoints (network required);
`.github/workflows/engine-compat.yml` runs only on manual dispatch, builds
real engines from source, and exercises offline scenarios without network
access; `tests/integration/real-engine.test.ts` is skipped unless
`STELLAR_CANARY_BIN` points to a real engine. The `smoke-test` job in
`.github/workflows/release.yml` runs the published Action with a real engine
after a version-tag release or on manual dispatch. None of these real-engine
workflows gates a pull request; `.github/workflows/ci.yml` provides the
required pull-request checks.

For tests that need to observe what the Action reports through
`@actions/core`, use the partial-mock convention described in [Mocking
`@actions/core`](#mocking-actionscore) below rather than mocking the module
your own way.

### Mocking `@actions/core`

When a test needs to assert on `core.error`, `core.warning`, or
`core.setFailed`, spread the real module and override only the exports that
test observes. Never replace `@actions/core` wholesale with a hand-written
object: unrelated exports such as `core.summary`, `core.getInput`, and
`core.setOutput` must keep working through the real implementation, and the
suite relies on that (for example, `core.summary` writes
`GITHUB_STEP_SUMMARY`). This is the pattern used by
`tests/unit/annotations.test.ts` and `tests/integration/end-to-end.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so the mock functions must be too.
const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));

vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return { ...actual, error: errorMock };
});

import { emitAnnotations } from "../../src/annotations";

afterEach(() => {
  errorMock.mockReset();
});
```

Key points:

- declare the spies with `vi.hoisted` so the hoisted `vi.mock` factory can
  reference them;
- take `importOriginal<typeof import("@actions/core")>()` and spread
  `...actual`, overriding only the functions under test;
- reset the mocks in `afterEach` (`mockReset()`) so assertions in one test
  do not see calls from another.

Only add a mock for an export the test actually asserts on; leaving the
rest real is what keeps these tests interoperable with the rest of the
suite.

## Build

`dist/index.js` is a committed, bundled artifact — consumers of this
Action never run `npm install`/`npm run build` themselves. Never hand-edit
it; always regenerate it with `npm run build` and commit the result. CI
fails if `dist/` doesn't match a fresh build from the current source.

This project bundles with **esbuild**, not `@vercel/ncc`: the pinned
`@actions/*` packages (`core` 3.x, `artifact` 6.x) ship as ESM-only, which
`ncc`'s webpack-based bundler cannot resolve into a CommonJS
`runs.using: node24` action. See `scripts/build.mjs` for the exact
settings.

## Mutation testing (StrykerJS)

Line coverage says little about whether the tests would notice a behavioural
change, so this repository has an on-demand mutation testing workflow:

- `.github/workflows/mutation.yml` — runs only on `workflow_dispatch`, so it
  never gates a pull request. It uses `npx` with pinned (but not saved)
  `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` versions,
  mutates `src/`, runs the unit suite against each mutant, and publishes the
  per-file mutation score and the top surviving mutants to the job summary
  and as a `mutation-report` artifact.
- `stryker.config.json` — the StrykerJS configuration: mutates `src/**/*.ts`,
  uses the Vitest runner against `tests/unit`, and emits JSON, Markdown, and
  HTML reports.

To run it locally:

```bash
# Install the Vitest runner once, without saving it to package.json or
# package-lock.json.
npm install --no-save @stryker-mutator/vitest-runner@7.7.4
npx --yes @stryker-mutator/core@7.7.4 stryker run
```

Reports are written to `reports/mutation/` (gitignored). Mutation survivors
point at assertions that are too weak to catch a real change: treat a
surviving mutant as a signal to strengthen the test, not as a reason to
lower the threshold. A deliberately weakened assertion in a scratch copy
shows up as a surviving mutant.

## Coding standards

- Strict TypeScript (`strict: true`); avoid `any`.
- Command execution: always an argument array to `child_process.spawn`
  (via `@actions/exec` or directly) — never a shell string built from an
  input. This is the one rule with no exceptions in this repository; see
  `SECURITY.md`.
- No duplicated compatibility logic. If you find yourself writing
  `if (protocol === 28) { ... }` or anything that encodes what a CAP
  means, that belongs in `Protocol-Canary` or `ProtocolCanary-Fixtures`,
  not here.
- Prefer the typed `CanaryActionError` subclasses in `src/errors.ts` over
  throwing a plain `Error`, so a caller can distinguish, for example, an
  installation failure from an invalid report.
- Workflow files in `.github/workflows/` must follow repository security policy:
  every workflow must explicitly declare a top-level `permissions:` block
  (least privilege), and every external `uses:` action reference must be pinned
  to a full 40-character commit SHA (with the single documented exception of the
  reusable workflow calling the action's own `@v1` release tag).

## Workflow linting and security checks

Workflow files are analyzed in CI using `actionlint` and `zizmor`, as well as
the vitest suite `tests/unit/workflow-policy.test.ts`.

To run these checks locally:

1. **Policy unit tests**:
   ```bash
   npm test
   # or run the policy test specifically:
   npx vitest run tests/unit/workflow-policy.test.ts
   ```
2. **actionlint** (checks syntax, expression schemas, and runner compatibility):
   ```bash
   actionlint .github/workflows/*.yml
   ```
   (Install via `go install github.com/rhysd/actionlint/cmd/actionlint@latest` or package manager).
3. **zizmor** (checks for credential persistence, injection risks, and unpinned actions):
   ```bash
   zizmor .github/workflows
   ```
   (Install via `pip install zizmor` or `cargo install zizmor`).

Prefer fixing findings directly over suppressing them. Any necessary suppression
must include an explicit `# zizmor: ignore[rule-name]` comment with a clear,
justified explanation on the affected line.

## Commit style

Use Conventional Commits, one logical change per commit:

```text
feat(action): add canary installation
fix(runner): forward SIGTERM to the child process
test(annotations): cover the warning-only case
docs: document the fixtures-dir input
```

## Updating dependencies

Update explicitly (`chore(deps): update @actions/core`), never silently as
a side effect of another change. Re-run the full test/lint/build sequence
after any dependency bump, run `npm run audit`, and run `npm run check:licenses` —
fix or explicitly justify any new advisory before merging.

Dependabot also opens automated update PRs for the npm and
`github-actions` ecosystems on a weekly schedule (see
`.github/dependabot.yml`), so some dependency updates arrive without
anyone hand-writing a `chore(deps):` commit. Those PRs are held to the
same review expectations as any other change: re-run the full
test/lint/build sequence, `npm run audit`, and `npm run check:licenses`
before merging one, and either fix or explicitly justify any new advisory in the PR.

### Dependency audit and vulnerability handling

CI runs `npm run audit` (`npm audit --omit=dev --audit-level=high`) on every
pull request and on a weekly schedule to detect high or critical advisories in
the production dependency tree that bundles into `dist/index.js`.

- **Report only in CI**: Do **not** use `npm audit fix` in CI. Vulnerabilities must
  be explicitly reviewed and resolved or triaged by maintainers.
- **When an audit reports a finding with a fix available**: Update the affected
  direct or transitive dependency (e.g. via `npm update <package>` or explicit
  package bump), re-run `npm run build`, and commit both `package-lock.json` and
  updated `dist/`.
- **When an audit reports a finding with NO fix available yet**:
  1. **Assess reachability and impact**: Determine whether the vulnerable code path
     in the transitive dependency is reachable in the context of this Action's bundle
     and execution model.
  2. **Check for upstream workarounds**: Check if an override in `package.json`
     (`overrides` field) can safely pin a patched transitive version without breaking
     runtime behavior.
  3. **Document and track**: If no upstream fix or safe override is available and the
     vulnerability is deemed unexploitable or low risk in the Action's context, open
     an issue or record the justification in the pull request review referencing the
     upstream advisory tracking issue. Temporary audit exceptions must be reviewed
     and approved by repository maintainers.

### License compliance checks

Production dependencies are verified against an allow-list located in
[`.licenses-allowlist.json`](.licenses-allowlist.json).

- Run `npm run check:licenses` locally to verify production dependencies.
- Allowed licenses include standard permissive licenses (`MIT`, `Apache-2.0`,
  `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `0BSD`, `BlueOak-1.0.0`, etc.).
- If a legitimate new production dependency or package with dual/custom licensing
  is added, propose updating `.licenses-allowlist.json` in the same pull request
  with maintainer review.

## Updating Canary compatibility

If `Protocol-Canary` changes its CLI interface, JSON report schema, or
exit-code contract:

1. re-read its current `docs/json-report-contract.md`,
   `docs/fixture-contract.md`, and `crates/canary-cli/src/cli.rs` —
   never assume the previous contract still holds;
2. update `src/output.ts`'s `CanaryReport` type and
   `SUPPORTED_SCHEMA_VERSION` (a `schemaVersion` bump is a breaking
   change: this Action should reject an unrecognized version clearly
   rather than silently misparse it — see `parseReport`);
3. update the supported-version table in `README.md`;
4. add a `MOCK_CANARY_SCENARIO` case exercising the new behavior in
   `tests/fixtures/mock-canary.cjs` before wiring the Action to it.

## Running real-engine compatibility tests

The compatibility workflow (`.github/workflows/engine-compat.yml`) tests the
Action against real builds of `Protocol-Canary` across all supported
operating systems (`ubuntu-latest`, `windows-latest`, and `macos-latest`).
Unlike the mock-based integration suite used during standard CI, this workflow
exercises the actual engine binary, verifying platform-specific behavior such
as binary naming (`stellar-canary.exe`), path handling, process spawning, and
timeouts in `src/runner.ts`.

### Running the workflow manually

The workflow runs on `workflow_dispatch` (manual trigger) and is not part of
required pull request checks because compiling the engine from source across
all platforms is resource-intensive.

To trigger the workflow manually:

1. **Via the GitHub web interface:** navigate to **Actions** &rarr;
   **Engine compatibility**, click **Run workflow**, choose the branch, and
   provide:
   - `engine_ref`: the Protocol-Canary tag, branch, or commit to test
     (for example `v0.2.0` or `main`).
   - `legacy_ref`: an older Protocol-Canary release (e.g. `v0.1.1`) to ensure
     backward compatibility.
2. **Via the GitHub CLI:**
   ```bash
   gh workflow run engine-compat.yml -f engine_ref=v0.2.0 -f legacy_ref=v0.1.1
   ```

To run `tests/integration/real-engine.test.ts` locally, point
`STELLAR_CANARY_BIN` (and optionally `STELLAR_CANARY_LEGACY_BIN`) to compiled
engine binaries. When these environment variables are absent, the test suite
skips cleanly with an informative message rather than failing, keeping
`npm test` fast for routine local development.

### Understanding platform-specific failures

The matrix is configured with `fail-fast: false`, ensuring a failure on one
operating system does not cancel execution on the others.

When a compatibility test fails on a specific platform (e.g., Windows or
macOS) while passing on Linux, it points to platform-specific code in the
Action rather than an engine logic defect:

- **Executable name and resolution:** Windows binaries require the `.exe`
  extension (`stellar-canary.exe`). If the binary lookup fails on Windows,
  verify `binaryName()` in `src/canary.ts` and path resolution logic.
- **Path separators and argument escaping:** Windows uses backslashes (`\`)
  and drive letters (`C:\...`), while POSIX platforms use forward slashes (`/`).
  Arguments passed to `child_process.spawn` must never assume POSIX path
  conventions or shell expansion.
- **Line endings:** Outputs and summaries generated on Windows runners can use
  CRLF (`\r\n`) line endings. Any parsing logic must handle both CRLF and LF.
- **Process spawning and signal forwarding:** Windows does not support POSIX
  process signals like `SIGTERM` or `SIGINT` in the same manner as Unix.
  Timeout handling and process termination in `src/runner.ts` must account for
  these differences.

## Pinning the fixtures packs (weekly live workflow)

The weekly workflow runs two independent network checks with **Engine v0.3.0**:

| Network | Scope | Immutable Fixtures commit | Path |
| --- | --- | --- | --- |
| Testnet | Protocol 30 `getVersionInfo.protocolVersion == 30` identity only | `9feb1a85f64cd43201685fe233bf9ef15a38a752` | `fixtures/protocol-30` |
| Futurenet | Published Protocol 29 pack | `347ad6846d46b7bdf605a299501354563d79f2d9` (`fixtures-p29-v0.1.1`) | `fixtures/protocol-29` |

The Protocol 30 commit is **not a released fixture pack**. Its one Testnet
RPC identity fixture and evidence were reviewed in Fixtures PRs #488 and
#489. This check does not establish Protocol 30 XDR, Soroban, transaction
semantics, Futurenet or Mainnet compatibility. Futurenet still checks the
released Protocol 29 pack. The workflow never assumes both networks
have the same current protocol.

Scheduled runs use each matrix leg's immutable commit, protocol and path.
A manual dispatch may supply `fixtures_ref` to override the checkout
commit for **both** legs; that ref must contain both selected pack paths
or the missing-pack check will fail. Overrides never change scheduled pins.

**How to update a pin:** only a maintainer-approved PR may change a
matrix leg's `fixtures_commit`, `protocol` and `fixtures_dir`. For a
published pack, resolve the release tag to its peeled commit with
`git ls-remote ... 'refs/tags/<tag>*'` and cite the release URL.
For an unreleased Protocol 30 candidate, cite the exact merged Fixtures
commit and verification evidence; do not describe it as published.
Keep each network's passphrase, RPC endpoint and other lane unchanged
unless separately justified by live evidence. Update the tests in
`tests/unit/weekly-live-fixture-pack.test.ts` and run `actionlint`,
`zizmor` and the complete test workflow before merging.
The approving reviewer is the CODEOWNERS maintainer.

## Tracking weekly live failures

A repeated scheduled failure should not open a new issue every Monday. The
`track-failure` job in `.github/workflows/weekly-live.yml` keeps exactly one
tracking issue per failure episode, labelled **`weekly-live`**:

- on the **first failing run** it opens a new issue titled
  "Weekly live canary is failing (Testnet/Futurenet)";
- while the canary stays red it **comments** on that same issue (it never
  opens a second one, even if several runs fail in a row);
- once a run goes **fully green** it comments on the open issue and closes
  it with `--reason completed`; a later failure reopens the cycle by
  creating a fresh issue.

The tracker uses `GH_REPO` because its job does not check out a working tree.
If the label is missing, the job creates it with its existing `issues: write`
permission before querying or creating the tracking issue. API and permission
errors still fail the job; they are not treated as a missing label. The
issue-writing job runs only for the `main` ref, including scheduled runs.

The `track-failure` job is the only job in the workflow granted
`issues: write`, and it is scoped to that job; every other job stays at the
workflow default of `contents: read`.

## Release process

Before creating a release, ensure all metadata values agree. `.github/workflows/release.yml`
runs `node scripts/verify-release-tag.mjs "$RELEASE_TAG"` before any installation or build
steps to enforce that the pushed tag matches `package.json` and `CHANGELOG.md`.

Release checklist:

1. **Update `package.json`**: Bump `"version": "X.Y.Z"` to match the intended release.
2. **Update `CHANGELOG.md`**:
   - Ensure `CHANGELOG.md` has a heading matching `## [X.Y.Z]` or `## [X.Y.Z] - YYYY-MM-DD`.
   - Ensure the release date (`YYYY-MM-DD`) is filled in before tagging.
   - Move relevant items from `## [Unreleased]` under the new version heading.
   - Link every entry to the pull request that introduced it with a trailing `([#123])` reference — e.g.
     "- Add the annotations input ([#42])." — so the diff and discussion
     for a change are one click away. Entries that predate the repository's
     pull-request workflow (everything up to and including `v0.1.1`)
     reference the commit that introduced the change instead, as
     `([0de71ec])`, since no pull request exists for them.
3. **Update `SECURITY.md`**: Update the supported-versions table by adding the new
   version as supported and marking previously released versions
   unsupported, keeping the table in sync with `CHANGELOG.md`'s
   release history.
4. **Tag `vX.Y.Z` on `main`**: Create an annotated tag whose name strictly matches
   `vX.Y.Z` (matching `package.json`'s version with a leading `v`). Pre-release
   suffixes (such as `-rc.1`) and unpinned or non-semver tags are rejected.
   `.github/workflows/release.yml` verifies that the tag, `package.json`, and
   `CHANGELOG.md` match before running tests and publishing a GitHub Release.
5. **Floating major tag**: The floating major tag (e.g. `v1`) is moved automatically by
   `.github/workflows/release.yml`, in the same job, after the release is
   created. No manual step is required. The workflow only ever moves the
   major tag forward: it is left untouched when the pushed tag is not the
   newest `vX.Y.Z` in that major line (a re-run, or a tag pushed out of
   order), and pre-1.0 releases publish no floating major tag at all.

5. A post-release smoke test (`smoke-test` job in `.github/workflows/release.yml`)
   runs immediately after the release is published. It invokes the Action by
   its published tag against an offline fixture project to exercise the real
   release artifact the way a consumer does, verifying `status`, check counts,
   and JSON report generation.

   To re-run the smoke test manually for an existing published release tag
   without re-publishing:
   ```bash
   gh workflow run release.yml -f release_tag=v0.1.1
   ```
   or trigger the **Release** workflow from the Actions tab in GitHub and enter
   the target tag in the `release_tag` input field.
