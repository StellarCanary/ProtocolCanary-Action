# Release download redirects (D-11)

D-11 remains blocked. This page separates the Action's behavior today from a
candidate policy for maintainer review. No redirect is followed by the runtime
download code, and nothing here grants approval to enable redirect following.

## Runtime behavior today

`httpsGetFile` makes one request to an absolute HTTPS release URL hosted on
`github.com`, with no userinfo, percent-encoded authority, or custom port. It
sends a User-Agent and no Authorization header. Any 3xx response is rejected
before its `Location` value is parsed or requested. Downloads are bounded by
one 120-second wall-clock deadline and the existing asset-size limit.

The Engine installer logs a warning and falls back to a pinned source build
after a prebuilt redirect is refused. That fallback requires a Rust toolchain
and can make installation much slower. `strict-integrity: true` retains its
existing rule: a source-built binary is rejected before execution, so a
redirected prebuilt release can make that run fail. Fixture-pack downloads do
not fall back to an Engine source build; a redirect fails the pack download.
The runtime never executes an unverified release binary.

## Observed release hosts

The host set below is limited to the one redirect transition verified for the
published Engine v0.2.0 binary. `api.github.com` is used for release metadata
and checksum requests; it has not been observed as a redirect source or target
and is not in the candidate redirect host set.

| Host | Observed role | Evidence |
|---|---|---|
| `github.com` | Source of the release asset redirect | On 2026-11-02 at 14:42 UTC, a HEAD request to `https://github.com/StellarCanary/Protocol-Canary/releases/download/v0.2.0/stellar-canary-linux-x86_64` returned `302`; its HTTPS `Location` hostname was `release-assets.githubusercontent.com`. The request did not follow the redirect. |
| `release-assets.githubusercontent.com` | Destination of that redirect | The Engine contract README records the same v0.2.0 asset hop returning `200 OK` on 2026-10-09. This Action re-observed the destination hostname in the 2026-11-02 `302`; it did not follow the `Location` during this check. |
| `api.github.com` | GitHub REST API for metadata | It appears in API request URLs, not in an observed redirect hop. Runtime API requests attach a bearer token only to a clean absolute HTTPS URL on this exact host, with no userinfo, encoded authority, or non-default port. |

Do not add CDN aliases, subdomains, or other hosts without new evidence and
maintainer approval. The only candidate redirect edge is the observed
`github.com` → `release-assets.githubusercontent.com` transition.

## Candidate policy for D-11 approval

The pure module `src/download-policy.ts` validates candidate redirect URLs but
is not imported by the runtime downloader. Its allowlist contains only the two
observed redirect hosts, and it currently allows only the observed directed
hop. Before any runtime integration, maintainers must review and approve the
exact rule, including:

1. HTTPS absolute URLs only; reject relative and protocol-relative `Location`
   values until their handling is explicitly approved.
2. Validate both source and destination against the exact observed host pair.
3. Reject userinfo, non-default ports, IP literals, look-alikes, trailing-dot
   hosts, and percent-encoded authorities before trusting WHATWG normalization.
4. Attach Authorization only to HTTPS requests to the exact API host. Reject
   unsafe URL authorities before making a request, and never send the token to
   release download URLs or redirect destinations. Runtime request helpers
   and the candidate header helper enforce this rule independently of
   redirect approval.
5. Permit no more than three hops. A future runtime implementation must use a
   single 120-second wall-clock deadline for the entire chain, not reset the
   timeout at each hop, and must retain the asset-size limit.
6. Reject any unlisted or unobserved transition and preserve source-build
   fallback only where the existing integrity mode permits it.

`MAX_REDIRECT_HOPS` is a candidate-policy cap only; it does not mean three
redirects have been observed. The only recorded transition has one hop.

## Threats and verification

- Token leakage: unsafe URLs never receive an Authorization header; runtime
  asset requests carry no token and redirects are not followed.
- Downgrade and host spoofing: the candidate validator requires HTTPS and
  exact hosts at both ends of a hop.
- Authority ambiguity: percent escapes in absolute or protocol-relative
  authorities are rejected before URL parsing; relative and protocol-relative
  targets are rejected outright.
- Unbounded chains: the candidate policy caps hops, and any approved runtime
  implementation must enforce one total time budget for the complete download.

Tests in `tests/unit/download-policy.test.ts` cover candidate URL validation
and credentials. `tests/unit/canary.test.ts` pins the current runtime behavior:
one request, no `Location` follow-up, partial-file cleanup, and bounded total
download time. Integration tests cover the Engine source fallback and the
strict-integrity rejection path.
