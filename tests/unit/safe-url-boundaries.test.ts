import { describe, expect, it } from "vitest";

import { isExactGithubApiUrl, parseSafeHttpsUrl } from "../../src/safe-url";

interface BackslashUrlCase {
  readonly name: string;
  readonly rawUrl: string;
  readonly expectedReason: string;
}

const BACKSLASH_AUTHORITY_AND_PATH_CASES: readonly BackslashUrlCase[] = [
  {
    name: "backslash before @userinfo split targeting attacker host",
    rawUrl: "https://api.github.com\\@attacker.example/repos/StellarCanary/Protocol-Canary",
    expectedReason: "backslashes are not allowed in URLs",
  },
  {
    name: "attacker host with backslash before @api.github.com",
    rawUrl: "https://attacker.example\\@api.github.com/repos/StellarCanary/Protocol-Canary",
    expectedReason: "backslashes are not allowed in URLs",
  },
  {
    name: "backslash delimiter immediately after trusted authority",
    rawUrl: "https://api.github.com\\repos\\StellarCanary\\Protocol-Canary",
    expectedReason: "backslashes are not allowed in URLs",
  },
  {
    name: "backslash inside path segment on GitHub API host",
    rawUrl: "https://api.github.com/repos/StellarCanary\\../attacker/releases",
    expectedReason: "backslashes are not allowed in URLs",
  },
  {
    name: "backslash inside query string on GitHub API host",
    rawUrl: "https://api.github.com/repos/StellarCanary/Protocol-Canary/releases?next=\\attacker.example",
    expectedReason: "backslashes are not allowed in URLs",
  },
  {
    name: "backslash inside URL fragment on GitHub API host",
    rawUrl: "https://api.github.com/repos/StellarCanary/Protocol-Canary#\\section",
    expectedReason: "backslashes are not allowed in URLs",
  },
  {
    name: "leading backslash in authority that WHATWG normalizes to api.github.com",
    rawUrl: "https://\\api.github.com/repos/StellarCanary/Protocol-Canary",
    expectedReason: "a non-empty URL authority is required",
  },
  {
    name: "double leading backslash in authority that WHATWG normalizes to api.github.com",
    rawUrl: "https://\\\\api.github.com/repos/StellarCanary/Protocol-Canary",
    expectedReason: "a non-empty URL authority is required",
  },
  {
    name: "backslash scheme separator that WHATWG normalizes to api.github.com",
    rawUrl: "https:\\\\api.github.com/repos/StellarCanary/Protocol-Canary",
    expectedReason: "an absolute HTTPS URL with an authority is required",
  },
  {
    name: "mixed slash-backslash scheme separator targeting api.github.com",
    rawUrl: "https:/\\api.github.com/repos/StellarCanary/Protocol-Canary",
    expectedReason: "an absolute HTTPS URL with an authority is required",
  },
];

describe("safe-url backslash normalization boundaries", () => {
  it.each(BACKSLASH_AUTHORITY_AND_PATH_CASES)(
    "rejects $name in parseSafeHttpsUrl and returns false from isExactGithubApiUrl",
    ({ rawUrl, expectedReason }) => {
      const parsed = parseSafeHttpsUrl(rawUrl);

      expect(parsed.url).toBeUndefined();
      expect(parsed.reason).toBe(expectedReason);
      expect(isExactGithubApiUrl(rawUrl)).toBe(false);
    },
  );

  it("blocks ambiguous backslash URLs that WHATWG URL normalization alone would classify as api.github.com", () => {
    const whatwgNormalizedSpoofs = [
      "https://api.github.com\\@attacker.example/repos",
      "https://\\api.github.com/repos",
      "https:\\\\api.github.com/repos",
      "https:/\\api.github.com/repos",
    ];

    for (const candidate of whatwgNormalizedSpoofs) {
      // Confirm the underlying hazard: raw WHATWG parsing normalizes backslashes
      // into forward slashes and reports "api.github.com" as the hostname.
      expect(new URL(candidate).hostname).toBe("api.github.com");

      // Confirm safe-url rejects every one before WHATWG normalization runs.
      const parsed = parseSafeHttpsUrl(candidate);
      expect(parsed.url).toBeUndefined();
      expect(parsed.reason).toBeDefined();
      expect(isExactGithubApiUrl(candidate)).toBe(false);
    }
  });

  it("continues to accept a clean HTTPS GitHub API URL without backslashes", () => {
    const cleanUrl = "https://api.github.com/repos/StellarCanary/Protocol-Canary/releases/latest";
    const parsed = parseSafeHttpsUrl(cleanUrl);

    expect(parsed.reason).toBeUndefined();
    expect(parsed.url?.href).toBe(cleanUrl);
    expect(isExactGithubApiUrl(cleanUrl)).toBe(true);
  });
});
