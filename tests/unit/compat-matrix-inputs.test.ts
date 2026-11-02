import { describe, expect, it } from "vitest";
import {
  buildMatrix,
  DEFAULT_ENGINE_REFS,
  DEFAULT_PACK_REFS,
  matrixForEvent,
  MAX_MATRIX_CELLS,
  MAX_REFERENCE_LENGTH,
  parseReferenceList,
} from "../../scripts/compat-matrix-inputs.mjs";

describe("compatibility matrix inputs", () => {
  it("uses the documented defaults for scheduled runs", () => {
    const matrix = matrixForEvent("schedule", "", "");
    expect(matrix.include).toHaveLength(4);
    expect(matrix.include.map((cell) => cell.engine_ref)).toEqual([
      "v0.1.1",
      "v0.1.1",
      "v0.2.0",
      "v0.2.0",
    ]);
    expect(matrix.include.map((cell) => cell.pack_ref)).toEqual([
      "protocol-28",
      "main",
      "protocol-28",
      "main",
    ]);
  });

  it("splits dispatch inputs into independent matrix values", () => {
    const matrix = matrixForEvent("workflow_dispatch", "v0.1.1,v0.2.0", "protocol-28,main");
    expect(matrix.include).toHaveLength(4);
    expect(matrix.include[0]).toMatchObject({ engine_ref: "v0.1.1", pack_ref: "protocol-28" });
    expect(matrix.include[1]).toMatchObject({ engine_ref: "v0.1.1", pack_ref: "main" });
    expect(matrix.include[2]).toMatchObject({ engine_ref: "v0.2.0", pack_ref: "protocol-28" });
    expect(matrix.include[3]).toMatchObject({ engine_ref: "v0.2.0", pack_ref: "main" });
  });

  it("trims surrounding whitespace from each reference", () => {
    expect(parseReferenceList("  v0.1.1 , main  ", "engine-refs")).toEqual(["v0.1.1", "main"]);
  });

  it("rejects blank lists and empty comma-separated values", () => {
    expect(() => parseReferenceList("   ", "engine-refs")).toThrow("at least one reference");
    expect(() => parseReferenceList("main, ,v0.2.0", "engine-refs")).toThrow("empty reference");
    expect(() => parseReferenceList("main,", "pack-refs")).toThrow("empty reference");
  });

  it("rejects malformed Git references", () => {
    expect(() => parseReferenceList("main,not a ref", "engine-refs")).toThrow("malformed Git reference");
    expect(() => parseReferenceList("bad..ref", "pack-refs")).toThrow("malformed Git reference");
  });

  it("rejects excessively long references before matrix generation", () => {
    const reference = `a${"b".repeat(MAX_REFERENCE_LENGTH)}`;
    expect(() => parseReferenceList(reference, "engine-refs")).toThrow("longer than");
  });

  it("rejects duplicate references", () => {
    expect(() => parseReferenceList("main, main", "pack-refs")).toThrow("duplicate reference");
  });

  it("rejects empty dispatch values instead of silently substituting defaults", () => {
    expect(() => matrixForEvent("workflow_dispatch", "", "main")).toThrow("engine-refs");
    expect(() => matrixForEvent("workflow_dispatch", "main", " ")).toThrow("pack-refs");
  });

  it("creates deterministic unique artifact identities", () => {
    const first = buildMatrix(DEFAULT_ENGINE_REFS, DEFAULT_PACK_REFS);
    const second = buildMatrix(DEFAULT_ENGINE_REFS, DEFAULT_PACK_REFS);
    expect(first).toEqual(second);
    expect(new Set(first.include.map((cell) => cell.cell_id)).size).toBe(first.include.length);
    expect(first.include.every((cell) => /^[a-z0-9-]+$/.test(cell.cell_id))).toBe(true);
  });

  it("rejects a matrix exceeding the GitHub Actions cell limit", () => {
    const refs = Array.from({ length: MAX_MATRIX_CELLS + 1 }, (_, index) => `ref-${index}`);
    expect(() => buildMatrix(refs, ["main"])).toThrow("limit is 256");
  });
});
