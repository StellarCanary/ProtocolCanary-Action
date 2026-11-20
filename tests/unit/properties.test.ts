import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { InvalidReportError } from "../../src/errors";
import { SUPPORTED_SCHEMA_VERSION, parseReport } from "../../src/output";
import { REDACTED, redact } from "../../src/redact";
import { MAX_DIAGNOSTIC_LENGTH, extractDiagnostic } from "../../src/runner";

const DEFAULT_SEED = 0x5354454c;

function resolveSeed(): number {
  const raw = process.env.SEED;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SEED;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed >>> 0 : DEFAULT_SEED;
}

/**
 * Deterministic Mulberry32 PRNG. No external dependencies.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[index] as T;
}

const SAFE_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.,/+=!@#$%^&*()[]{}|;<>?~\n\t";

function genString(rng: () => number, maxLen = 64, allowKnownDefectChars = true): string {
  const len = randInt(rng, 0, maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += SAFE_ALPHABET[randInt(rng, 0, SAFE_ALPHABET.length - 1)] ?? "a";
  }
  if (allowKnownDefectChars && rng() < 0.15) {
    out += "::";
  }
  if (!allowKnownDefectChars) {
    out = out.replace(/`/g, "'").replace(/::+/g, ":");
  }
  return out;
}

function genArbitraryJsonValue(rng: () => number, depth = 0): unknown {
  if (depth > 5) {
    return pick(rng, [null, true, false, 0, 1, -1, "leaf", ""]);
  }
  const kind = randInt(rng, 0, 8);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return rng() < 0.5;
    case 2:
      return randInt(rng, -1_000_000, 1_000_000);
    case 3:
      return Number.MAX_SAFE_INTEGER * (rng() < 0.5 ? 1 : -1);
    case 4:
      return genString(rng, 40);
    case 5: {
      const len = randInt(rng, 0, 4);
      const arr: unknown[] = [];
      for (let i = 0; i < len; i++) {
        arr.push(genArbitraryJsonValue(rng, depth + 1));
      }
      return arr;
    }
    default: {
      const keys = randInt(rng, 0, 5);
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < keys; i++) {
        obj[`k_${String(i)}_${genString(rng, 6, false)}`] = genArbitraryJsonValue(rng, depth + 1);
      }
      return obj;
    }
  }
}

function genValidBaseReport(rng: () => number): Record<string, unknown> {
  const surfaces = ["xdr", "rpc", "soroban"] as const;
  const statuses = ["pass", "warning", "fail", "error", "skipped"] as const;
  const overallStatuses = ["pass", "warning", "fail", "error"] as const;

  const numResults = randInt(rng, 0, 5);
  const results: Record<string, unknown>[] = [];
  const counts = {
    total: numResults,
    passed: 0,
    failed: 0,
    warnings: 0,
    errors: 0,
    skipped: 0,
  };

  for (let i = 0; i < numResults; i++) {
    const surface = pick(rng, surfaces);
    const status = pick(rng, statuses);
    if (status === "pass") counts.passed += 1;
    else if (status === "fail") counts.failed += 1;
    else if (status === "warning") counts.warnings += 1;
    else if (status === "error") counts.errors += 1;

    const entry: Record<string, unknown> = {
      testId: `test-${String(i)}`,
      protocol: randInt(rng, 20, 30),
      surface,
      status,
      summary: `summary ${String(i)}`,
      durationMs: randInt(rng, 0, 5000),
      fixtureId: rng() < 0.3 ? null : `fix-${String(i)}`,
    };
    if (rng() < 0.5) {
      entry.details = genString(rng, 32);
    }
    results.push(entry);
  }

  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    toolVersion: "0.2.0",
    targetProtocol: randInt(rng, 20, 30),
    project: { name: "prop-project", type: "soroban-contract" },
    status: pick(rng, overallStatuses),
    counts,
    results,
    git: { commit: null, branch: null, isDirty: null },
  };
}

function genMutatedReportCandidate(rng: () => number, iteration: number): string {
  // Mix of valid reports, mutated reports, arbitrary JSON shapes, and raw non-JSON strings
  const mode = iteration % 5;
  if (mode === 0) {
    return JSON.stringify(genValidBaseReport(rng));
  }
  if (mode === 1) {
    const mutated = genValidBaseReport(rng);
    const field = pick(rng, [
      "schemaVersion",
      "toolVersion",
      "targetProtocol",
      "project",
      "network",
      "status",
      "counts",
      "results",
      "skipped",
    ]);
    if (rng() < 0.3) {
      delete mutated[field];
    } else {
      mutated[field] = genArbitraryJsonValue(rng, 1);
    }
    return JSON.stringify(mutated);
  }
  if (mode === 2) {
    const mutated = genValidBaseReport(rng);
    const results = mutated.results as Record<string, unknown>[];
    if (results.length > 0) {
      const target = results[0] as Record<string, unknown>;
      const rField = pick(rng, ["testId", "protocol", "surface", "status", "summary", "details", "durationMs", "fixtureId"]);
      target[rField] = genArbitraryJsonValue(rng, 2);
    }
    return JSON.stringify(mutated);
  }
  if (mode === 3) {
    return JSON.stringify(genArbitraryJsonValue(rng, 0));
  }
  return genString(rng, 80);
}

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALPHANUM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function genChars(rng: () => number, alphabet: string, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[randInt(rng, 0, alphabet.length - 1)] ?? "A";
  }
  return out;
}

interface KnownDefectEntry {
  readonly id: string;
  readonly property: string;
  readonly input: string;
  readonly observedOutput: string;
  readonly expectedOutput: string;
  readonly expectedBehaviour: string;
  readonly issue: string;
}

describe("deterministic property tests (#442)", () => {
  const seed = resolveSeed();

  it("parseReport: handles 1,000 generated inputs and throws only InvalidReportError on invalid ones", () => {
    const rng = mulberry32(seed);
    const iterations = 1000;
    let validCount = 0;
    let invalidCount = 0;

    for (let i = 0; i < iterations; i++) {
      const candidate = genMutatedReportCandidate(rng, i);
      try {
        const report = parseReport(candidate);
        validCount += 1;
        expect(report.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
        expect(Array.isArray(report.results)).toBe(true);
      } catch (error) {
        invalidCount += 1;
        if (!(error instanceof InvalidReportError)) {
          throw new Error(
            `[SEED=${String(seed)}] Iteration ${String(i)} threw unexpected error ${String(error)} for input: ${candidate}`,
          );
        }
      }
    }

    expect(validCount + invalidCount).toBe(iterations);
    expect(validCount).toBeGreaterThan(0);
    expect(invalidCount).toBeGreaterThan(0);
  });

  it("redact: satisfies idempotence redact(redact(x)) === redact(x) and masks secrets across 500 generated inputs", () => {
    const rng = mulberry32(seed ^ 0x13579bdf);
    const iterations = 500;

    for (let i = 0; i < iterations; i++) {
      const prefix = genString(rng, 24, false);
      const middle = genString(rng, 24, false);
      const suffix = genString(rng, 24, false);

      const ghPrefix = pick(rng, ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]);
      const ghToken = `${ghPrefix}${genChars(rng, ALPHANUM_CHARS, randInt(rng, 36, 48))}`;
      const finePat = `github_pat_${genChars(rng, `${ALPHANUM_CHARS}_`, randInt(rng, 22, 40))}`;
      const stellarSeed = `S${genChars(rng, BASE32_CHARS, 55)}`;
      const urlUser = genChars(rng, ALPHANUM_CHARS, 8);
      const urlPass = genChars(rng, ALPHANUM_CHARS, 12);
      const urlSecret = genChars(rng, ALPHANUM_CHARS, 16);
      const credUrl = `https://${urlUser}:${urlPass}@rpc.example.com/v1?token=${urlSecret}`;

      const composed = `${prefix} ${ghToken} ${middle} ${finePat} ${stellarSeed} ${credUrl} ${suffix}`;
      const once = redact(composed);
      const twice = redact(once);

      if (twice !== once) {
        throw new Error(
          `[SEED=${String(seed)}] redact idempotence failed at iteration ${String(i)}: input=${JSON.stringify(composed)} once=${JSON.stringify(once)} twice=${JSON.stringify(twice)}`,
        );
      }

      if (
        once.includes(ghToken) ||
        once.includes(finePat) ||
        once.includes(stellarSeed) ||
        once.includes(urlPass) ||
        once.includes(urlSecret)
      ) {
        throw new Error(
          `[SEED=${String(seed)}] redact failed to mask secret at iteration ${String(i)}: output=${JSON.stringify(once)}`,
        );
      }
      expect(once).toContain(REDACTED);
    }
  });

  it("extractDiagnostic: never exceeds MAX_DIAGNOSTIC_LENGTH and is deterministic across 500 generated inputs", () => {
    const rng = mulberry32(seed ^ 0x2468ace0);
    const iterations = 500;
    const prefixes = ["", "error: ", "panic: ", "fatal: ", "failed: ", "info: ", "warning: "];

    for (let i = 0; i < iterations; i++) {
      const lineCount = randInt(rng, 0, 12);
      const lines: string[] = [];
      for (let j = 0; j < lineCount; j++) {
        const lead = pick(rng, prefixes);
        const len = rng() < 0.25 ? randInt(rng, 500, 1200) : randInt(rng, 0, 120);
        lines.push(`${lead}${genString(rng, len)}`);
      }
      const stderr = lines.join(rng() < 0.5 ? "\n" : "\r\n");

      const first = extractDiagnostic(stderr);
      const second = extractDiagnostic(stderr);
      const byteLen = Buffer.byteLength(first, "utf8");

      if (first !== second) {
        throw new Error(
          `[SEED=${String(seed)}] extractDiagnostic non-deterministic at iteration ${String(i)} for input=${JSON.stringify(stderr)}`,
        );
      }
      if (byteLen > MAX_DIAGNOSTIC_LENGTH) {
        throw new Error(
          `[SEED=${String(seed)}] extractDiagnostic length ${String(byteLen)} exceeded MAX_DIAGNOSTIC_LENGTH (${String(MAX_DIAGNOSTIC_LENGTH)}) at iteration ${String(i)}`,
        );
      }
    }
  });

  it("verifies recorded known defects in tests/fixtures/property-known-defects.json and fails when fixed", () => {
    const fixturePath = path.join(__dirname, "..", "fixtures", "property-known-defects.json");
    const raw = fs.readFileSync(fixturePath, "utf8");
    const entries = JSON.parse(raw) as readonly KnownDefectEntry[];
    expect(Array.isArray(entries)).toBe(true);

    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.property).toBeTruthy();
      expect(entry.expectedBehaviour).toBeTruthy();
      expect(entry.issue).toMatch(/^https:\/\/github\.com\//);

      if (entry.property === "redact(redact(x)) === redact(x)") {
        const once = redact(entry.input);
        const twice = redact(once);

        if (twice === once && once === entry.expectedOutput) {
          throw new Error(
            `Known defect "${entry.id}" (${entry.issue}) is now fixed! Move this case into the enforced properties in tests/unit/properties.test.ts and delete it from tests/fixtures/property-known-defects.json.`,
          );
        }

        expect(once).toBe(entry.expectedOutput);
        expect(twice).toBe(entry.observedOutput);
      }
    }
  });
});
