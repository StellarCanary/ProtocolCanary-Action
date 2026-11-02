import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_ENGINE_REFS = Object.freeze(["v0.1.1", "v0.2.0"]);
export const DEFAULT_PACK_REFS = Object.freeze(["protocol-28", "main"]);
export const MAX_MATRIX_CELLS = 256;
export const MAX_REFERENCE_LENGTH = 255;

function isValidReference(reference) {
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(reference)) {
    return true;
  }

  const result = spawnSync("git", ["check-ref-format", "--allow-onelevel", reference], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Could not validate Git reference: ${result.error.message}`);
  }
  return result.status === 0;
}

export function parseReferenceList(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a comma-separated string`);
  }

  const references = value.split(",").map((reference) => reference.trim());
  if (references.length === 0 || references.every((reference) => reference === "")) {
    throw new Error(`${label} must contain at least one reference`);
  }
  if (references.some((reference) => reference === "")) {
    throw new Error(`${label} contains an empty reference`);
  }

  const seen = new Set();
  for (const reference of references) {
    if (reference.length > MAX_REFERENCE_LENGTH) {
      throw new Error(`${label} contains a reference longer than ${MAX_REFERENCE_LENGTH} characters`);
    }
    if (!isValidReference(reference)) {
      throw new Error(`${label} contains a malformed Git reference: ${JSON.stringify(reference)}`);
    }
    if (seen.has(reference)) {
      throw new Error(`${label} contains a duplicate reference: ${JSON.stringify(reference)}`);
    }
    seen.add(reference);
  }

  return references;
}

export function buildMatrix(engineRefs, packRefs) {
  if (!Array.isArray(engineRefs) || engineRefs.length === 0) {
    throw new Error("Engine references must be a non-empty array");
  }
  if (!Array.isArray(packRefs) || packRefs.length === 0) {
    throw new Error("Fixture references must be a non-empty array");
  }

  const cellCount = engineRefs.length * packRefs.length;
  if (cellCount > MAX_MATRIX_CELLS) {
    throw new Error(`The compatibility matrix has ${cellCount} cells; the limit is ${MAX_MATRIX_CELLS}`);
  }

  const include = [];
  for (const engineRef of engineRefs) {
    for (const packRef of packRefs) {
      const digest = createHash("sha256").update(`${engineRef}\0${packRef}`).digest("hex").slice(0, 12);
      const index = String(include.length + 1).padStart(3, "0");
      include.push({
        engine_ref: engineRef,
        pack_ref: packRef,
        cell_id: `cell-${index}-${digest}`,
      });
    }
  }

  return { include };
}

export function matrixForEvent(eventName, engineInput, packInput) {
  const engineValue = eventName === "schedule" ? DEFAULT_ENGINE_REFS.join(",") : engineInput;
  const packValue = eventName === "schedule" ? DEFAULT_PACK_REFS.join(",") : packInput;
  return buildMatrix(
    parseReferenceList(engineValue, "engine-refs"),
    parseReferenceList(packValue, "pack-refs"),
  );
}

export function writeMatrixOutput(matrix, outputPath) {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new Error("GITHUB_OUTPUT is required to publish the compatibility matrix");
  }
  appendFileSync(
    outputPath,
    `matrix=${JSON.stringify(matrix)}\ncell_count=${matrix.include.length}\n`,
    "utf8",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const matrix = matrixForEvent(
      process.env.EVENT_NAME ?? "",
      process.env.ENGINE_REFS ?? "",
      process.env.PACK_REFS ?? "",
    );
    writeMatrixOutput(matrix, process.env.GITHUB_OUTPUT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
