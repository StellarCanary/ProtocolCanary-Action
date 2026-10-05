## What changed?

Added a new unit test in `tests/unit/canary.test.ts` to verify that `ensureCanaryInstalled` successfully falls back to commit/tag pinning when a checksum manifest exists but contains no valid digest lines (i.e., parses to zero entries).

## Why?

To ensure that a malformed-but-present checksum manifest safely degrades to weaker version pinning instead of throwing an error or silently misbehaving. This confirms the robustness of the fallback mechanism in `lookupPublishedChecksums` and `parseChecksumManifest` in `src/canary.ts`.

## Tests performed

- [x] `npm run build`
- [x] `npm test`
- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `dist/` rebuilt and committed (must match a fresh `npm run build`)

## Changelog

Does this change anything people using the Action will notice? If so, it
needs an entry in `CHANGELOG.md` under `[Unreleased]`:

- [x] `CHANGELOG.md` updated under `[Unreleased]` (or this change is
      internal-only)

## Related issue

Closes #260

## Compatibility impact

Does this change an input, output, or the supported `Protocol-Canary`
version range? If so, update the README's Inputs/Outputs/"Supported
Canary versions" tables.

None. This is an internal testing change.

## Breaking change?

- [ ] Yes — described above
- [x] No
