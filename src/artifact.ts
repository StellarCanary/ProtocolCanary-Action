import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import * as path from "node:path";

/**
 * The stable, documented artifact name used by the common case of a single
 * Action invocation per workflow run. It is always tried first, so existing
 * consumers are never silently renamed.
 */
export const ARTIFACT_NAME = "stellar-protocol-canary-report";

export interface ArtifactUploadOutcome {
  readonly uploaded: boolean;
  readonly reason?: string;
}

/**
 * Reduces a caller-supplied differentiator (for example the resolved
 * protocol/network) to a value that is valid inside a GitHub artifact
 * name. GitHub permits alphanumerics, `-`, `_`, and `.`; everything else
 * collapses to `-`.
 */
function sanitizeDifferentiator(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Builds the name used when the stable {@link ARTIFACT_NAME} is already
 * taken in the current workflow run. A `differentiator` keeps the name
 * stable and predictable (e.g. `stellar-protocol-canary-report-protocol-28`);
 * without one, a short unique suffix is used so nothing collides.
 */
export function fallbackArtifactName(differentiator?: string): string {
  const suffix = differentiator === undefined ? "" : sanitizeDifferentiator(differentiator);
  if (suffix !== "") {
    return `${ARTIFACT_NAME}-${suffix}`;
  }
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return `${ARTIFACT_NAME}-${unique}`;
}

/**
 * True when `error` is the artifact API rejecting a name that already
 * exists in the current workflow run (a 409 Conflict), as opposed to any
 * other upload failure. `@actions/artifact` surfaces this as
 * `Received non-retryable error: Failed request: (409) Conflict: ...`.
 */
export function isArtifactNameCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/\(409\)/.test(message) || /conflict/i.test(message)) {
    return true;
  }
  return /already exists/i.test(message) && /artifact/i.test(message);
}

/**
 * Uploads the JSON report as a workflow artifact. Artifact upload is
 * always auxiliary (section 30/62 of the product spec): a failure here is
 * logged as a warning and reflected in the returned outcome, but it never
 * throws and never changes the underlying compatibility result.
 *
 * GitHub requires artifact names to be unique within a workflow run, so a
 * second invocation (a matrix leg, or a second Action step) would
 * otherwise fail to upload. The stable {@link ARTIFACT_NAME} is tried
 * first; only if the service reports that name as taken does the upload
 * retry once under a name derived from `differentiator` (falling back to a
 * short unique suffix when none was provided).
 */
export async function uploadReport(
  reportPath: string,
  differentiator?: string,
): Promise<ArtifactUploadOutcome> {
  let name = ARTIFACT_NAME;
  try {
    const client = new DefaultArtifactClient();
    try {
      await client.uploadArtifact(ARTIFACT_NAME, [reportPath], path.dirname(reportPath));
    } catch (error) {
      if (!isArtifactNameCollision(error)) {
        throw error;
      }
      name = fallbackArtifactName(differentiator);
      core.info(
        `Artifact name "${ARTIFACT_NAME}" is already used in this workflow run; ` +
          `uploading this report as "${name}" instead.`,
      );
      await client.uploadArtifact(name, [reportPath], path.dirname(reportPath));
    }
    core.info(`Uploaded ${name} artifact.`);
    return { uploaded: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to upload ${name} artifact: ${reason}`);
    return { uploaded: false, reason };
  }
}
