// Tests for `writeSummary()`: the only place the Action talks to `core.summary`.
//
// Issue #189: the markdown must reach `core.summary.addRaw(...)` (with the
// wrap flag) and be written exactly once, and a failing publish must surface as
// a `SummaryPublishFailedError` rather than an arbitrary error — the caller in
// run() distinguishes them when it reports the failure.
import { beforeEach, describe, expect, it, vi } from "vitest";

const summaryMocks = vi.hoisted(() => {
  const write = vi.fn();
  const addRaw = vi.fn(() => ({ write }));
  return { addRaw, write };
});

vi.mock("@actions/core", () => ({ summary: summaryMocks }));

import { SummaryPublishFailedError } from "../../src/errors";
import { writeSummary } from "../../src/summary";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("writeSummary", () => {
  it("publishes the markdown through core.summary and resolves with nothing", async () => {
    await expect(writeSummary("## Stellar Protocol Canary\n\n✅ **PASS**")).resolves.toBeUndefined();

    expect(summaryMocks.addRaw).toHaveBeenCalledTimes(1);
    expect(summaryMocks.addRaw).toHaveBeenCalledWith("## Stellar Protocol Canary\n\n✅ **PASS**", true);
    expect(summaryMocks.write).toHaveBeenCalledTimes(1);
  });

  it("wraps a publish failure in SummaryPublishFailedError with the original message", async () => {
    summaryMocks.write.mockRejectedValueOnce(new Error("service unavailable"));

    const fallo = await writeSummary("cuerpo").catch((e: unknown) => e);

    expect(fallo).toBeInstanceOf(SummaryPublishFailedError);
    expect((fallo as Error).message).toBe("Failed to publish Canary summary: service unavailable");
    expect((fallo as SummaryPublishFailedError).code).toBe("SummaryPublishFailed");
  });

  it("stringifies a non-Error rejection instead of losing it", async () => {
    summaryMocks.write.mockRejectedValueOnce("boom");

    const fallo = await writeSummary("cuerpo").catch((e: unknown) => e);

    expect((fallo as Error).message).toBe("Failed to publish Canary summary: boom");
  });
});
