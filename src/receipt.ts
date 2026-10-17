import type { CanaryReport } from "./output";

/**
 * Machine-readable Execution Receipt (receiptVersion 1).
 *
 * A receipt is a lightweight provenance record of what this Action ran: the
 * engine version and build commit, the fixture-pack digest, the requested and
 * observed protocol versions, and when the run happened. It is deliberately
 * **not** a signed cryptographic attestation — nothing here proves that a
 * third party performed the run, and it must not be presented as if it did.
 *
 * Older engine releases may not emit `engineCommit` or `packDigest` in their
 * JSON report. Those fields are recorded as {@link UNKNOWN_RECEIPT_VALUE}
 * rather than guessed, so a consumer can always distinguish "not reported"
 * from a real value.
 */
export const RECEIPT_VERSION = 1;

/** Placeholder for receipt fields the engine did not report. */
export const UNKNOWN_RECEIPT_VALUE = "unknown";

/** A field that is either genuinely reported or explicitly `"unknown"`. */
export type KnownOrUnknown<T> = T | typeof UNKNOWN_RECEIPT_VALUE;

export interface ExecutionReceipt {
  /** Shape version of this receipt document. */
  readonly receiptVersion: typeof RECEIPT_VERSION;
  /** Engine version that produced the report (`toolVersion`). */
  readonly engineVersion: KnownOrUnknown<string>;
  /** Engine build commit, when the report carries it. */
  readonly engineCommit: KnownOrUnknown<string>;
  /** Canonical digest of the fixture pack that was executed, e.g. `sha256:<hex>`. */
  readonly packDigest: KnownOrUnknown<string>;
  /** Protocol version the run targeted. */
  readonly protocol: KnownOrUnknown<number>;
  /** Protocol version actually observed on the network, for live checks. */
  readonly observedProtocol: KnownOrUnknown<number>;
  /** ISO-8601 UTC timestamp of when the receipt was produced. */
  readonly timestamp: string;
}

/** Normalizes an optional string field, defaulting to `"unknown"`. */
function knownString(value: unknown): KnownOrUnknown<string> {
  return typeof value === "string" && value.trim() !== "" ? value : UNKNOWN_RECEIPT_VALUE;
}

/** Normalizes an optional numeric field, defaulting to `"unknown"`. */
function knownNumber(value: unknown): KnownOrUnknown<number> {
  return typeof value === "number" && Number.isFinite(value) ? value : UNKNOWN_RECEIPT_VALUE;
}

/**
 * Builds a receipt from a parsed Canary report.
 *
 * `timestamp` is injected so callers (and tests) can produce a deterministic
 * document; it defaults to the current time in ISO-8601 UTC.
 */
export function receiptFromReport(
  report: CanaryReport,
  timestamp: string = new Date().toISOString(),
): ExecutionReceipt {
  return {
    receiptVersion: RECEIPT_VERSION,
    engineVersion: knownString(report.toolVersion),
    engineCommit: knownString(report.engineCommit),
    packDigest: knownString(report.packDigest),
    protocol: knownNumber(report.targetProtocol),
    observedProtocol: knownNumber(report.network?.observedProtocol),
    timestamp,
  };
}

/**
 * Serializes a receipt with a fixed key order and no insignificant
 * whitespace. The trailing newline makes the result a well-formed text file
 * while remaining byte-for-byte deterministic for the same receipt.
 */
export function serializeReceipt(receipt: ExecutionReceipt): string {
  const ordered = {
    receiptVersion: receipt.receiptVersion,
    engineVersion: receipt.engineVersion,
    engineCommit: receipt.engineCommit,
    packDigest: receipt.packDigest,
    protocol: receipt.protocol,
    observedProtocol: receipt.observedProtocol,
    timestamp: receipt.timestamp,
  };
  return `${JSON.stringify(ordered)}\n`;
}
