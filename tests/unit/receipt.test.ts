import { describe, expect, it } from "vitest";

import { report } from "./helpers";
import {
  RECEIPT_VERSION,
  UNKNOWN_RECEIPT_VALUE,
  receiptFromReport,
  serializeReceipt,
} from "../../src/receipt";

const TIMESTAMP = "2026-10-17T12:00:00.000Z";

describe("receiptFromReport", () => {
  it("builds a receiptVersion 1 receipt from the report's provenance fields", () => {
    const receipt = receiptFromReport(
      report({
        toolVersion: "0.2.0",
        targetProtocol: 28,
        network: { name: "testnet", observedProtocol: 28 },
        engineCommit: "0123456789abcdef0123456789abcdef01234567",
        packDigest: `sha256:${"a".repeat(64)}`,
      }),
      TIMESTAMP,
    );

    expect(receipt).toEqual({
      receiptVersion: RECEIPT_VERSION,
      engineVersion: "0.2.0",
      engineCommit: "0123456789abcdef0123456789abcdef01234567",
      packDigest: `sha256:${"a".repeat(64)}`,
      protocol: 28,
      observedProtocol: 28,
      timestamp: TIMESTAMP,
    });
  });

  it("falls back to \"unknown\" when older reports omit commit and pack digest", () => {
    const receipt = receiptFromReport(report({ toolVersion: "0.1.0" }), TIMESTAMP);

    expect(receipt.engineCommit).toBe(UNKNOWN_RECEIPT_VALUE);
    expect(receipt.packDigest).toBe(UNKNOWN_RECEIPT_VALUE);
    // A known, reported value is never replaced by the fallback.
    expect(receipt.engineVersion).toBe("0.1.0");
  });

  it("falls back to \"unknown\" for blank or non-string metadata instead of guessing", () => {
    const malformed = report({
      toolVersion: "",
      engineCommit: 42 as unknown as string,
      packDigest: "   ",
    });
    const receipt = receiptFromReport(malformed, TIMESTAMP);

    expect(receipt.engineVersion).toBe(UNKNOWN_RECEIPT_VALUE);
    expect(receipt.engineCommit).toBe(UNKNOWN_RECEIPT_VALUE);
    expect(receipt.packDigest).toBe(UNKNOWN_RECEIPT_VALUE);
  });

  it("records the observed protocol when a live network run reported it", () => {
    const receipt = receiptFromReport(report({ network: { name: "mainnet", observedProtocol: 29 } }), TIMESTAMP);
    expect(receipt.observedProtocol).toBe(29);
  });

  it("records \"unknown\" for the observed protocol on offline runs", () => {
    const receipt = receiptFromReport(report({}), TIMESTAMP);
    expect(receipt.observedProtocol).toBe(UNKNOWN_RECEIPT_VALUE);
  });

  it("records \"unknown\" for a missing or non-finite target protocol", () => {
    const missing = report({ targetProtocol: undefined as unknown as number });
    const nonFinite = report({ targetProtocol: Number.NaN });

    expect(receiptFromReport(missing, TIMESTAMP).protocol).toBe(UNKNOWN_RECEIPT_VALUE);
    expect(receiptFromReport(nonFinite, TIMESTAMP).protocol).toBe(UNKNOWN_RECEIPT_VALUE);
  });

  it("defaults the timestamp to a current ISO-8601 UTC instant", () => {
    const before = Date.now();
    const receipt = receiptFromReport(report({}));
    const after = Date.now();

    expect(receipt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const parsed = Date.parse(receipt.timestamp);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe("serializeReceipt", () => {
  const receipt = receiptFromReport(
    report({
      toolVersion: "0.2.0",
      network: { name: "testnet", observedProtocol: 28 },
      engineCommit: "deadbeef",
      packDigest: `sha256:${"b".repeat(64)}`,
    }),
    TIMESTAMP,
  );

  it("emits the documented fields in a fixed order with a trailing newline", () => {
    expect(serializeReceipt(receipt)).toBe(
      '{"receiptVersion":1,"engineVersion":"0.2.0","engineCommit":"deadbeef",' +
        `"packDigest":"sha256:${"b".repeat(64)}","protocol":28,"observedProtocol":28,` +
        '"timestamp":"2026-10-17T12:00:00.000Z"}\n',
    );
  });

  it("is deterministic: repeated serialization is byte-identical", () => {
    expect(serializeReceipt(receipt)).toBe(serializeReceipt(receipt));
  });

  it("round-trips through JSON.parse", () => {
    expect(JSON.parse(serializeReceipt(receipt))).toEqual(receipt);
  });

  it("makes no cryptographic claims: no signature or attestation fields", () => {
    const keys = Object.keys(JSON.parse(serializeReceipt(receipt)) as Record<string, unknown>);
    expect(keys).toEqual([
      "receiptVersion",
      "engineVersion",
      "engineCommit",
      "packDigest",
      "protocol",
      "observedProtocol",
      "timestamp",
    ]);
    expect(keys).not.toContain("signature");
    expect(keys).not.toContain("attestation");
  });
});
