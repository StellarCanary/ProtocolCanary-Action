import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import * as path from "node:path";

export const ARTIFACT_NAME = "stellar-protocol-canary-report";

export interface ArtifactUploadOutcome {
  readonly uploaded: boolean;
  readonly reason?: string;
}

/**
 * Uploads the JSON report as a workflow artifact. Artifact upload is
 * always auxiliary (section 30/62 of the product spec): a failure here is
 * logged as a warning and reflected in the returned outcome, but it never
 * throws and never changes the underlying compatibility result.
 */
export async function uploadReport(reportPath: string): Promise<ArtifactUploadOutcome> {
  try {
    const client = new DefaultArtifactClient();
    await client.uploadArtifact(ARTIFACT_NAME, [reportPath], path.dirname(reportPath));
    core.info(`Uploaded ${ARTIFACT_NAME} artifact.`);
    return { uploaded: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to upload ${ARTIFACT_NAME} artifact: ${reason}`);
    return { uploaded: false, reason };
  }
}
