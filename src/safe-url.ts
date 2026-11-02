/** Result of parsing an untrusted URL for an HTTPS request. */
export type SafeHttpsUrlResult =
  | { readonly url: URL; readonly reason?: never }
  | { readonly url?: never; readonly reason: string };

function rawAuthority(rawUrl: string): string | undefined {
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(rawUrl);
  if (schemeMatch === null) return undefined;
  const rest = rawUrl.slice(schemeMatch[0].length);
  const authorityEnd = rest.search(/[\\/?#]/);
  return authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
}

/**
 * Parse an untrusted absolute URL before an HTTPS request. The raw authority
 * is checked before WHATWG normalization so encoded hosts and userinfo cannot
 * be normalized into a trusted hostname.
 */
export function parseSafeHttpsUrl(rawUrl: string): SafeHttpsUrlResult {
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rawUrl);
  if (schemeMatch === null) {
    return { reason: "an absolute HTTPS URL with an authority is required" };
  }
  if (schemeMatch[1]?.toLowerCase() !== "https") {
    return { reason: "URL must use HTTPS" };
  }

  const authority = rawAuthority(rawUrl);
  if (authority === undefined || authority === "") {
    return { reason: "a non-empty URL authority is required" };
  }
  if (authority.includes("%")) {
    return { reason: "percent-encoded URL authorities are not allowed" };
  }
  if (authority.includes("@")) {
    return { reason: "URL userinfo is not allowed" };
  }
  if (rawUrl.includes("\\")) {
    return { reason: "backslashes are not allowed in URLs" };
  }
  for (const character of rawUrl) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return { reason: "control characters are not allowed in URLs" };
    }
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { reason: "invalid URL" };
  }

  if (url.protocol !== "https:") {
    return { reason: "URL must use HTTPS" };
  }
  if (url.username !== "" || url.password !== "") {
    return { reason: "URL userinfo is not allowed" };
  }
  if (url.port !== "") {
    return { reason: "non-default URL ports are not allowed" };
  }
  if (url.hostname === "") {
    return { reason: "URL hostname is required" };
  }
  return { url };
}

/** True only for a clean HTTPS URL on the exact GitHub REST API host. */
export function isExactGithubApiUrl(rawUrl: string): boolean {
  const result = parseSafeHttpsUrl(rawUrl);
  return result.url?.hostname.toLowerCase() === "api.github.com";
}
