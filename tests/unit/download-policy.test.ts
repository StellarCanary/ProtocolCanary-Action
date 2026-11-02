import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALLOWED_REDIRECT_HOSTS,
  MAX_REDIRECT_HOPS,
  evaluateDownloadUrl,
  evaluateRedirectHop,
  getHeadersForUrl,
} from "../../src/download-policy";

const GH = "https://github.com/StellarCanary/Protocol-Canary/releases/download/v0.2.0/stellar-canary-linux-x86_64";
const CDN = "https://release-assets.githubusercontent.com/some/path?token=abc";
const API = "https://api.github.com/repos/StellarCanary/Protocol-Canary/releases/tags/v0.2.0";

interface HopCase {
  name: string;
  from: string;
  to: string;
  hop?: number;
  allowed: boolean;
  reasonIncludes?: string;
}

const cases: HopCase[] = [
  { name: "observed github to release CDN hop", from: GH, to: CDN, allowed: true },
  { name: "unobserved CDN to github transition rejected", from: CDN, to: GH, allowed: false, reasonIncludes: "pair" },
  { name: "unobserved self redirect rejected", from: GH, to: GH, allowed: false, reasonIncludes: "pair" },
  { name: "unknown HTTPS destination rejected", from: GH, to: "https://attacker.example/x", allowed: false, reasonIncludes: "allow-list" },
  { name: "github.com look-alike rejected", from: GH, to: "https://github.com.attacker.example/x", allowed: false, reasonIncludes: "allow-list" },
  { name: "github look-alike rejected", from: GH, to: "https://evilgithub.com/x", allowed: false, reasonIncludes: "allow-list" },
  { name: "unlisted subdomain rejected", from: GH, to: "https://raw.github.com/x", allowed: false, reasonIncludes: "allow-list" },
  { name: "unobserved API host is not a redirect source", from: API, to: GH, allowed: false, reasonIncludes: "source" },
  { name: "unobserved API host is not a redirect destination", from: GH, to: API, allowed: false, reasonIncludes: "allow-list" },
  { name: "unknown redirect source rejected", from: "https://attacker.example/x", to: GH, allowed: false, reasonIncludes: "source" },
  { name: "HTTP source rejected", from: "http://github.com/x", to: GH, allowed: false, reasonIncludes: "source" },
  { name: "HTTP downgrade rejected", from: GH, to: "http://github.com/x", allowed: false, reasonIncludes: "https" },
  { name: "HTTP CDN downgrade rejected", from: CDN, to: "http://release-assets.githubusercontent.com/x", allowed: false, reasonIncludes: "https" },
  { name: "file scheme rejected", from: GH, to: "file:///etc/passwd", allowed: false, reasonIncludes: "https" },
  { name: "data scheme rejected", from: GH, to: "data:text/plain,hi", allowed: false, reasonIncludes: "https" },
  { name: "javascript scheme rejected", from: GH, to: "javascript:alert(1)", allowed: false, reasonIncludes: "https" },
  { name: "other URL schemes rejected", from: GH, to: "gopher://github.com/x", allowed: false, reasonIncludes: "https" },
  { name: "IPv4 target rejected", from: GH, to: "https://192.168.0.1/x", allowed: false, reasonIncludes: "IP literal" },
  { name: "IPv6 target rejected", from: GH, to: "https://[2001:db8::1]/x", allowed: false, reasonIncludes: "IP literal" },
  { name: "IP source rejected", from: "https://127.0.0.1/x", to: GH, allowed: false, reasonIncludes: "source" },
  { name: "target userinfo rejected", from: GH, to: "https://user:pass@github.com/x", allowed: false, reasonIncludes: "userinfo" },
  { name: "target username rejected", from: GH, to: "https://user@github.com/x", allowed: false, reasonIncludes: "userinfo" },
  { name: "target password rejected", from: GH, to: "https://:pass@github.com/x", allowed: false, reasonIncludes: "userinfo" },
  { name: "empty target userinfo marker rejected", from: GH, to: "https://@github.com/x", allowed: false, reasonIncludes: "userinfo" },
  { name: "empty source userinfo marker rejected", from: "https://@github.com/x", to: CDN, allowed: false, reasonIncludes: "source" },
  { name: "source userinfo rejected", from: "https://user:pass@github.com/x", to: CDN, allowed: false, reasonIncludes: "source" },
  { name: "target custom port rejected", from: GH, to: "https://github.com:8443/x", allowed: false, reasonIncludes: "port" },
  { name: "source custom port rejected", from: "https://github.com:8443/x", to: CDN, allowed: false, reasonIncludes: "source" },
  { name: "non-default CDN source port rejected", from: "https://release-assets.githubusercontent.com:444/x", to: GH, allowed: false, reasonIncludes: "source" },
  { name: "default HTTPS port allowed", from: GH, to: "https://release-assets.githubusercontent.com:443/x", allowed: true },
  { name: "trailing dot target rejected", from: GH, to: "https://github.com./x", allowed: false, reasonIncludes: "allow-list" },
  { name: "uppercase source hostname is normalized", from: "https://GITHUB.COM/releases/x", to: CDN, allowed: true },
  { name: "uppercase target hostname is normalized", from: GH, to: "https://RELEASE-ASSETS.GITHUBUSERCONTENT.COM/x", allowed: true },
  { name: "percent-encoded target authority rejected", from: GH, to: "https://%67ithub.com/x", allowed: false, reasonIncludes: "percent-encoded" },
  { name: "percent-encoded source authority rejected", from: "https://%67ithub.com/x", to: CDN, allowed: false, reasonIncludes: "source" },
  { name: "relative path target rejected", from: GH, to: "/releases/asset", allowed: false, reasonIncludes: "relative" },
  { name: "relative path target cannot change host", from: GH, to: "../../other", allowed: false, reasonIncludes: "relative" },
  { name: "query-only target rejected", from: GH, to: "?other=1", allowed: false, reasonIncludes: "relative" },
  { name: "protocol-relative allowed host rejected", from: GH, to: "//release-assets.githubusercontent.com/x", allowed: false, reasonIncludes: "relative" },
  { name: "protocol-relative arbitrary host rejected", from: GH, to: "//attacker.example/x", allowed: false, reasonIncludes: "relative" },
  { name: "protocol-relative percent-encoded authority rejected", from: GH, to: "//%67ithub.com/x", allowed: false, reasonIncludes: "percent-encoded" },
  { name: "protocol-relative encoded userinfo and host rejected", from: GH, to: "//user%40name@github.com/x", allowed: false, reasonIncludes: "percent-encoded" },
  { name: "backslash protocol-relative authority rejected", from: GH, to: "\\\\release-assets.githubusercontent.com\\x", allowed: false, reasonIncludes: "relative" },
  { name: "first hop is within the three-hop limit", from: GH, to: CDN, hop: 0, allowed: true },
  { name: "third hop is within the three-hop limit", from: GH, to: CDN, hop: MAX_REDIRECT_HOPS - 1, allowed: true },
  { name: "fourth redirect is rejected", from: GH, to: CDN, hop: MAX_REDIRECT_HOPS, allowed: false, reasonIncludes: "maximum" },
  { name: "hop above limit is rejected", from: GH, to: CDN, hop: MAX_REDIRECT_HOPS + 1, allowed: false, reasonIncludes: "maximum" },
  { name: "negative hop is rejected", from: GH, to: CDN, hop: -1, allowed: false, reasonIncludes: "hop index" },
  { name: "fractional hop is rejected", from: GH, to: CDN, hop: 0.5, allowed: false, reasonIncludes: "hop index" },
  { name: "infinite hop is rejected", from: GH, to: CDN, hop: Number.POSITIVE_INFINITY, allowed: false, reasonIncludes: "hop index" },
];

describe("evaluateDownloadUrl", () => {
  it("accepts only absolute HTTPS URLs from the observed redirect hosts", () => {
    expect(evaluateDownloadUrl(GH).allowed).toBe(true);
    expect(evaluateDownloadUrl(CDN).allowed).toBe(true);
    expect(evaluateDownloadUrl(API).allowed).toBe(false);
    expect(evaluateDownloadUrl("https://unknown.example/file").allowed).toBe(false);
    expect(evaluateDownloadUrl("/relative/file").allowed).toBe(false);
  });
});

describe("evaluateRedirectHop", () => {
  it.each(cases)("$name", ({ from, to, hop, allowed, reasonIncludes }) => {
    const result = evaluateRedirectHop(from, to, hop ?? 0);
    expect(result.allowed).toBe(allowed);
    if (reasonIncludes !== undefined) {
      expect(result.reason.toLowerCase()).toContain(reasonIncludes.toLowerCase());
    }
  });

  it("allows only the observed github-to-CDN hop in a chain", () => {
    expect(evaluateRedirectHop(GH, CDN, 0).allowed).toBe(true);
    expect(evaluateRedirectHop(CDN, GH, 1).allowed).toBe(false);
  });

  it("allows percent escapes in the path and query while validating the raw authority", () => {
    expect(
      evaluateRedirectHop(GH, "https://release-assets.githubusercontent.com/signed%2Fasset?sig=%2F", 0).allowed,
    ).toBe(true);
  });

  it("does not throw on malformed URLs or unknown schemes", () => {
    for (const target of ["", "gopher://github.com/x", "https:///github.com/x", "http://["]) {
      expect(() => evaluateRedirectHop(GH, target, 0)).not.toThrow();
      expect(evaluateRedirectHop(GH, target, 0).allowed).toBe(false);
    }
  });
});

describe("getHeadersForUrl", () => {
  it("attaches Authorization only to an HTTPS API URL with no userinfo or custom port", () => {
    expect(getHeadersForUrl(API, { token: "secret" }).Authorization).toBe("Bearer secret");
    expect(getHeadersForUrl("https://API.GITHUB.COM/repos", { token: "secret" }).Authorization).toBe("Bearer secret");
  });

  it.each([
    "http://api.github.com/repos",
    "https://api.github.com:8443/repos",
    "https://user:pass@api.github.com/repos",
    "https://@api.github.com/repos",
    "https://%61pi.github.com/repos",
    "https://api.github.com.attacker.example/repos",
    "https://attacker.example/repos",
    "https://github.com/repos",
    "https://release-assets.githubusercontent.com/file",
    "//api.github.com/repos",
    "/repos",
  ])("never attaches Authorization to unsafe or non-API URL %s", (url) => {
    expect(getHeadersForUrl(url, { token: "secret" }).Authorization).toBeUndefined();
  });

  it("omits Authorization when token is empty or missing", () => {
    expect(getHeadersForUrl(API, { token: "" }).Authorization).toBeUndefined();
    expect(getHeadersForUrl(API, {}).Authorization).toBeUndefined();
  });

  it("includes a User-Agent even when a URL is rejected", () => {
    expect(getHeadersForUrl("http://api.github.com", { token: "secret" })["User-Agent"]).toBeDefined();
  });
});

describe("policy constants", () => {
  it("lists only the two hosts observed in the release-asset redirect", () => {
    expect(ALLOWED_REDIRECT_HOSTS).toEqual([
      "github.com",
      "release-assets.githubusercontent.com",
    ]);
  });
  it("caps a proposed redirect chain at three hops", () => {
    expect(MAX_REDIRECT_HOPS).toBe(3);
  });
});

describe("policy module isolation (#425)", () => {
  it("is not imported by runtime files while D-11 remains blocked", () => {
    const srcDir = path.join(__dirname, "..", "..", "src");
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    const violations: string[] = [];
    for (const file of files) {
      if (file === "download-policy.ts") continue;
      if (/download-policy/.test(fs.readFileSync(path.join(srcDir, file), "utf8"))) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("imports no network module", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "download-policy.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']https["']/);
    expect(source).not.toMatch(/from\s+["']http["']/);
    expect(source).not.toMatch(/from\s+["']node:https["']/);
    expect(source).not.toMatch(/from\s+["']node:http["']/);
    expect(source).not.toMatch(/require\(["']net["']\)/);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});
