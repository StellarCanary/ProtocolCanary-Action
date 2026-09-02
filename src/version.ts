import * as core from "@actions/core";
import * as https from "node:https";

export const CANARY_REPO_OWNER = "StellarCanary";
export const CANARY_REPO_NAME = "Protocol-Canary";
export const CANARY_REPO_URL = `https://github.com/${CANARY_REPO_OWNER}/${CANARY_REPO_NAME}.git`;

export interface ResolvedVersion {
  /** The bare semantic version, e.g. "0.1.0". */
  readonly version: string;
  /** The git tag this version corresponds to, e.g. "v0.1.0". */
  readonly tag: string;
  /**
   * The commit the tag pointed to at resolution time, when it could be
   * resolved. Protocol-Canary does not (yet) publish signed release
   * artifacts or checksums, so pinning `cargo install` to this immutable
   * commit — rather than the mutable tag — is this Action's integrity
   * mechanism (see SECURITY.md). `undefined` if resolution failed, in
   * which case the caller falls back to installing from the tag directly.
   */
  readonly commitSha: string | undefined;
}

/** Resolves a bare version (e.g. "0.1.0") to its upstream tag and, if
 * possible, the immutable commit it currently points to. Never throws:
 * network/API failures degrade to `commitSha: undefined`. */
export async function resolveVersion(version: string): Promise<ResolvedVersion> {
  const tag = `v${version}`;
  const commitSha = await resolveTagCommit(tag).catch((error: unknown) => {
    core.debug(`Could not resolve ${tag} to a commit sha, falling back to tag pinning: ${String(error)}`);
    return undefined;
  });
  return { version, tag, commitSha };
}

interface GitHubTag {
  readonly name?: unknown;
  readonly commit?: { readonly sha?: unknown };
}

/**
 * Resolves a tag to the commit it points to, using the `tags` list endpoint
 * (which GitHub already peels to a commit sha for both lightweight and
 * annotated tags) rather than `git/refs/tags/{tag}` (which returns a tag
 * *object* sha for annotated tags and would need a second peeling call).
 *
 * Only the first 100 tags are considered — acceptable for this repository
 * today (one release tag) and a documented limitation if it grows.
 */
function resolveTagCommit(tag: string): Promise<string | undefined> {
  const url = `https://api.github.com/repos/${CANARY_REPO_OWNER}/${CANARY_REPO_NAME}/tags?per_page=100`;
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "ProtocolCanary-Action",
          Accept: "application/vnd.github+json",
        },
        timeout: 10_000,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`GitHub API returned status ${String(response.statusCode)} for ${url}`));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body) as unknown;
            if (!Array.isArray(parsed)) {
              reject(new Error("unexpected response shape from GitHub API"));
              return;
            }
            const match = (parsed as GitHubTag[]).find((entry) => entry.name === tag);
            const sha = match?.commit?.sha;
            if (typeof sha !== "string" || sha.length === 0) {
              reject(new Error(`tag ${tag} not found in the first 100 tags`));
              return;
            }
            resolve(sha);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error(`timed out resolving ${url}`));
    });
    request.on("error", reject);
  });
}
