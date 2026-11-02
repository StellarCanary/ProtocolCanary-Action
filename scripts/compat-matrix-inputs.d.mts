export interface MatrixCell {
  engine_ref: string;
  pack_ref: string;
  cell_id: string;
}

export interface CompatibilityMatrix {
  include: MatrixCell[];
}

export const DEFAULT_ENGINE_REFS: readonly string[];
export const DEFAULT_PACK_REFS: readonly string[];
export const MAX_MATRIX_CELLS: number;
export const MAX_REFERENCE_LENGTH: number;

export function parseReferenceList(value: string, label: string): string[];
export function buildMatrix(engineRefs: readonly string[], packRefs: readonly string[]): CompatibilityMatrix;
export function matrixForEvent(eventName: string, engineInput: string, packInput: string): CompatibilityMatrix;
export function writeMatrixOutput(matrix: CompatibilityMatrix, outputPath: string): void;
