import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InvalidReportError, isCanaryActionError } from "../../src/errors";
import { SUPPORTED_SCHEMA_VERSION, parseReport } from "../../src/output";
import { REDACTED, redact } from "../../src/redact";
import { MAX_DIAGNOSTIC_LENGTH, extractDiagnostic } from "../../src/runner";

/**
 * #442: Deterministic property-based tests for the pure functions that process
 * untrusted engine output and environment-derived strings:
 *   - `parseReport` (`src/output.ts`)
 *   - `redact` (`src/redact.ts`)
 *   - `extractDiagnostic` (`src/runner.ts`)
 *
 * Uses a self-contained seeded PRNG (mulberry32). The seed defaults to a fixed
 * constant and can be overridden with `SEED=<n> npm test`; every failure
 * prints the seed and the failing input so any failure can be reproduced
 * deterministically.
 */

const KNOWN_DEFECTS_PATH = path.join(__dirname, "..", "fixtures", "property-known-defects.json");

const DEFAULT_SEED = 0x4420a075;
const PARSE_REPORT_ITERATIONS = 1_200;
const REDACT_IDEMPOTENCE_ITERATIONS = 600;
const REDACT_MASKING_ITERATIONS = 600;
const EXTRACT_DIAGNOSTIC_ITERATIONS = 600;

export type PropertyName =
  | "parseReport"
  | "redact-idempotence"
  | "redact-masking"
  | "extractDiagnostic";

export interface KnownDefectEntry {
  readonly property: PropertyName;
  readonly input: string;
  readonly observed: string;
  readonly expected: string;
  readonly description?: string;
  readonly issue: string;
}

const VALID_PROPERTIES: ReadonlySet<string> = new Set<PropertyName>([
  "parseReport",
  "redact-idempotence",
  "redact-masking",
  "extractDiagnostic",
]);

const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+$/;

function readSeed(raw: string | undefined = process.env.SEED): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SEED;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`SEED must be an integer between 0 and 4294967295, got "${raw}"`);
  }
  return parsed >>> 0;
}

const SEED = readSeed();

/** mulberry32: deterministic 32-bit PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  const item = items[index];
  if (item === undefined) {
    throw new Error(`pick: index ${String(index)} out of bounds for length ${String(items.length)}`);
  }
  return item;
}

function randomChars(rng: () => number, alphabet: string, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(rng() * alphabet.length);
    out += alphabet[idx] ?? "";
  }
  return out;
}

/**
 * Tiny deterministic shrinker: given an input string that satisfies `fails`,
 * first checks all contiguous substrings from shortest to longest, then
 * greedily removes 1- or 2-character slices until no smaller failing string
 * can be found.
 */
function shrinkString(input: string, fails: (candidate: string) => boolean): string {
  let current = input;

  for (let len = 1; len < current.length; len += 1) {
    let foundShorter = false;
    for (let start = 0; start + len <= current.length; start += 1) {
      const sub = current.slice(start, start + len);
      if (fails(sub)) {
        current = sub;
        foundShorter = true;
        break;
      }
    }
    if (foundShorter) {
      break;
    }
  }

  let changed = true;
  while (changed && current.length > 1) {
    changed = false;
    for (const step of [2, 1]) {
      if (current.length <= step) {
        continue;
      }
      for (let i = 0; i + step <= current.length; i += 1) {
        const candidate = current.slice(0, i) + current.slice(i + step);
        if (fails(candidate)) {
          current = candidate;
          changed = true;
          break;
        }
      }
      if (changed) {
        break;
      }
    }
  }

  return current;
}

// ---------------------------------------------------------------------------
// Generators for JSON values, reports, strings, secrets, and diagnostics.
// ---------------------------------------------------------------------------

const SURFACES = ["xdr", "rpc", "soroban"] as const;
const RESULT_STATUSES = ["pass", "warning", "fail", "error", "skipped"] as const;
const OVERALL_STATUSES = ["pass", "warning", "fail", "error"] as const;
const PROJECT_TYPES = ["soroban", "rpc-consumer", "stellar-sdk", "generic-stellar", "custom"] as const;
const SKIP_CODES = [
  "UNSUPPORTED_PROTOCOL",
  "SURFACE_DISABLED",
  "MISSING_CAPABILITY",
  "OFFLINE",
  "NETWORK_MISMATCH",
  "UNKNOWN",
] as const;

const ALPHA_NUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALPHA_NUM_UNDERSCORE = `${ALPHA_NUM}_`;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const GENERAL_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:/?#@.&=-+`\\ \t\n\r\"'<>[]{}()!;$%^*,|~";
const SAFE_IDEMPOTENT_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/?#@.&=-+\\ \t\n\r\"'<>[]{}()!;$%^*,|~";
const SURROUNDING_TEXT_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.,;+-=/\\ \t\n()[]{}!@#$%^&*|~";
const UNICODE_SAMPLES = ["é", "€", "🚀", "🧪", "α", "β", "Ж", "漢", "\u0000", "\u0007", "\u001b[31m", "\u001b[0m"];

function generateString(rng: () => number, maxLen = 40): string {
  const len = randInt(rng, 0, maxLen);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    if (rng() < 0.08) {
      out += pick(rng, UNICODE_SAMPLES);
    } else {
      out += GENERAL_CHARS[Math.floor(rng() * GENERAL_CHARS.length)] ?? "a";
    }
  }
  return out;
}

/**
 * Generates strings that exercise `redact` (including single colons `:`,
 * workflow command pairs `::`, URLs, tokens, seeds, backslashes, quotes, and
 * Unicode) without containing the two known unfixed `escapeWorkflowCommands`
 * patterns (raw backtick `` ` `` or runs of 3+ colons `:::`).
 */
function generateIdempotentSafeString(rng: () => number, maxLen = 48): string {
  const len = randInt(rng, 0, maxLen);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    const roll = rng();
    if (roll < 0.08) {
      // Add `::` or `:` separated from any adjacent `:` so runs of 3+ colons do not form.
      const pair = rng() < 0.6 ? "::" : ":";
      if (out.endsWith(":")) {
        out += ` ${pair} `;
      } else {
        out += `${pair} `;
      }
    } else if (roll < 0.14) {
      out += pick(rng, UNICODE_SAMPLES);
    } else {
      out += SAFE_IDEMPOTENT_CHARS[Math.floor(rng() * SAFE_IDEMPOTENT_CHARS.length)] ?? "a";
    }
  }
  if (rng() < 0.25) {
    const secret = generateEmbeddedSecretCase(rng).secret;
    out = `${out} ${secret} `;
  }
  // Ensure no accidental `:::` or backtick was introduced.
  return out.replace(/`/g, "'").replace(/:{3,}/g, "::");
}

function generateDeepJsonValue(rng: () => number, depth: number): unknown {
  if (depth <= 0 || rng() < 0.35) {
    const choice = randInt(rng, 0, 9);
    switch (choice) {
      case 0:
        return null;
      case 1:
        return rng() < 0.5;
      case 2:
        return randInt(rng, -100, 100);
      case 3:
        return pick(rng, [
          0,
          -0,
          1,
          -1,
          1.5,
          -3.14159,
          Number.MAX_SAFE_INTEGER,
          Number.MIN_SAFE_INTEGER,
          Number.MAX_VALUE,
          Number.MIN_VALUE,
          1e100,
          -1e100,
        ]);
      case 4:
        return "";
      case 5:
        return randomChars(rng, ALPHA_NUM_UNDERSCORE, randInt(rng, 1, 16));
      case 6:
        return [];
      case 7:
        return {};
      case 8:
        return pick(rng, ["pass", "warning", "fail", "error", "skipped", "xdr", "rpc", "soroban"]);
      default:
        return generateString(rng, 20);
    }
  }

  if (rng() < 0.5) {
    const length = randInt(rng, 0, 4);
    const arr: unknown[] = [];
    for (let i = 0; i < length; i += 1) {
      arr.push(generateDeepJsonValue(rng, depth - 1));
    }
    return arr;
  }

  const keyCount = randInt(rng, 0, 5);
  const obj: Record<string, unknown> = {};
  const specialKeys = [
    "schemaVersion",
    "status",
    "results",
    "counts",
    "project",
    "network",
    "toolVersion",
    "targetProtocol",
    "skipped",
    "git",
    "__proto__",
    "constructor",
    "toString",
    "valueOf",
    "",
  ];
  for (let i = 0; i < keyCount; i += 1) {
    const key =
      rng() < 0.6
        ? pick(rng, specialKeys)
        : randomChars(rng, ALPHA_NUM_UNDERSCORE, randInt(rng, 1, 10));
    Object.defineProperty(obj, key, {
      value: generateDeepJsonValue(rng, depth - 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return obj;
}

function generateValidReportObject(rng: () => number): Record<string, unknown> {
  const targetProtocol = randInt(rng, 1, 50);
  const resultCount = randInt(rng, 0, 5);
  const results: Record<string, unknown>[] = [];
  let passed = 0;
  let failed = 0;
  let warnings = 0;
  let errors = 0;

  for (let i = 0; i < resultCount; i += 1) {
    const status = pick(rng, RESULT_STATUSES);
    if (status === "pass") passed += 1;
    else if (status === "fail") failed += 1;
    else if (status === "warning") warnings += 1;
    else if (status === "error") errors += 1;

    const entry: Record<string, unknown> = {
      testId: `test-${String(i)}-${randomChars(rng, ALPHA_NUM, 4)}`,
      protocol: targetProtocol,
      surface: pick(rng, SURFACES),
      status,
      summary: `summary ${String(i)}`,
      durationMs: randInt(rng, 0, 10_000),
      fixtureId: rng() < 0.2 ? null : `fixture-${String(i)}-${randomChars(rng, ALPHA_NUM, 4)}`,
    };
    if (rng() < 0.35) {
      entry.details = `details for ${String(i)}`;
    }
    if (rng() < 0.3) {
      entry.source = pick(rng, ["live", "cache", "custom"]);
    }
    results.push(entry);
  }

  const skippedCount = rng() < 0.4 ? randInt(rng, 0, 3) : 0;
  const skipped: Record<string, unknown>[] = [];
  for (let i = 0; i < skippedCount; i += 1) {
    const skipEntry: Record<string, unknown> = {
      fixtureId: `skip-${String(i)}`,
      surface: pick(rng, SURFACES),
      reason: `reason ${String(i)}`,
    };
    if (rng() < 0.5) {
      skipEntry.code = pick(rng, SKIP_CODES);
    }
    skipped.push(skipEntry);
  }

  const report: Record<string, unknown> = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    toolVersion: `0.${String(randInt(rng, 1, 9))}.${String(randInt(rng, 0, 9))}`,
    targetProtocol,
    project: {
      name: `proj-${randomChars(rng, ALPHA_NUM, 5)}`,
      type: pick(rng, PROJECT_TYPES),
    },
    status: pick(rng, OVERALL_STATUSES),
    counts: {
      total: results.length,
      passed,
      failed,
      warnings,
      errors,
      skipped: skipped.length,
    },
    results,
  };

  if (skipped.length > 0 || rng() < 0.2) {
    report.skipped = skipped;
  }
  if (rng() < 0.5) {
    report.network =
      rng() < 0.15
        ? null
        : {
            name: pick(rng, ["testnet", "mainnet", "futurenet"]),
            ...(rng() < 0.7 ? { observedProtocol: randInt(rng, 1, 50) } : {}),
            ...(rng() < 0.2 ? { error: "rpc warning" } : {}),
          };
  }
  if (rng() < 0.5) {
    report.git = {
      commit: rng() < 0.8 ? randomChars(rng, "0123456789abcdef", 7) : null,
      branch: rng() < 0.8 ? "main" : null,
      isDirty: rng() < 0.8 ? rng() < 0.5 : null,
    };
  }
  return report;
}

function mutateReportObject(rng: () => number, base: Record<string, unknown>): unknown {
  const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const mutationCount = randInt(rng, 1, 3);

  for (let m = 0; m < mutationCount; m += 1) {
    const kind = randInt(rng, 0, 15);
    switch (kind) {
      case 0: {
        // Delete a top-level field
        const keys = Object.keys(clone);
        if (keys.length > 0) {
          delete clone[pick(rng, keys)];
        }
        break;
      }
      case 1: {
        // Replace a top-level field with a random wrong-typed value
        const keys = [
          "schemaVersion",
          "toolVersion",
          "targetProtocol",
          "project",
          "network",
          "status",
          "counts",
          "results",
          "skipped",
          "git",
        ];
        clone[pick(rng, keys)] = generateDeepJsonValue(rng, 2);
        break;
      }
      case 2: {
        // Huge or non-integer numbers in numeric fields
        const huge = pick(rng, [
          0,
          -1,
          -999999,
          1.5,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_VALUE,
          -Number.MAX_VALUE,
          1e308,
        ]);
        const target = pick(rng, ["schemaVersion", "targetProtocol"]);
        clone[target] = huge;
        break;
      }
      case 3: {
        // Mutate project subfields
        clone.project =
          rng() < 0.3
            ? null
            : {
                name: generateDeepJsonValue(rng, 1),
                type: generateDeepJsonValue(rng, 1),
              };
        break;
      }
      case 4: {
        // Mutate network subfields
        clone.network = {
          name: rng() < 0.5 ? "testnet" : generateDeepJsonValue(rng, 1),
          observedProtocol: generateDeepJsonValue(rng, 1),
          error: generateDeepJsonValue(rng, 1),
        };
        break;
      }
      case 5: {
        // Mutate counts to disagree or have invalid member types
        clone.counts = {
          total: generateDeepJsonValue(rng, 1),
          passed: randInt(rng, -5, 100),
          failed: randInt(rng, -5, 100),
          warnings: randInt(rng, -5, 100),
          errors: randInt(rng, -5, 100),
          skipped: rng() < 0.5 ? undefined : randInt(rng, -5, 100),
        };
        break;
      }
      case 6: {
        // Mutate an entry inside results[]
        if (Array.isArray(clone.results) && clone.results.length > 0) {
          const idx = randInt(rng, 0, clone.results.length - 1);
          if (rng() < 0.25) {
            clone.results[idx] = generateDeepJsonValue(rng, 2);
          } else {
            const entry = (clone.results[idx] ?? {}) as Record<string, unknown>;
            const field = pick(rng, [
              "testId",
              "protocol",
              "surface",
              "status",
              "summary",
              "details",
              "durationMs",
              "fixtureId",
            ]);
            if (rng() < 0.3) {
              delete entry[field];
            } else {
              entry[field] = generateDeepJsonValue(rng, 2);
            }
          }
        }
        break;
      }
      case 7: {
        // Duplicate result identity in results[]
        if (Array.isArray(clone.results) && clone.results.length > 0) {
          clone.results.push(JSON.parse(JSON.stringify(clone.results[0])));
        }
        break;
      }
      case 8: {
        // Mutate skipped[]
        clone.skipped = [generateDeepJsonValue(rng, 2)];
        break;
      }
      case 9: {
        // Deep nesting inside an additive or existing field
        let nested: unknown = "leaf";
        const depth = randInt(rng, 10, 25);
        for (let d = 0; d < depth; d += 1) {
          nested = d % 2 === 0 ? { nested } : [nested];
        }
        if (rng() < 0.5) {
          clone.deepExtra = nested;
        } else {
          clone.results = nested;
        }
        break;
      }
      default: {
        // Replace entire value with a deep random JSON value
        return generateDeepJsonValue(rng, randInt(rng, 1, 6));
      }
    }
  }

  return clone;
}

function generateParseReportInput(rng: () => number, index: number): string {
  // Guarantee a rich mix of valid reports, mutated reports, deep trees, huge numbers, and raw strings.
  const bucket = index % 10;
  if (bucket < 2) {
    return JSON.stringify(generateValidReportObject(rng));
  }
  if (bucket < 7) {
    const base = generateValidReportObject(rng);
    return JSON.stringify(mutateReportObject(rng, base));
  }
  if (bucket === 7) {
    return JSON.stringify(generateDeepJsonValue(rng, randInt(rng, 2, 4)));
  }
  if (bucket === 8) {
    // Deeply nested JSON string (up to 30 levels) or huge numeric literal
    const depth = randInt(rng, 12, 30);
    if (rng() < 0.5) {
      return `${"[".repeat(depth)}1${"]".repeat(depth)}`;
    }
    return `{"schemaVersion":1,"targetProtocol":${"9".repeat(randInt(rng, 20, 400))}}`;
  }
  // Corrupted / truncated JSON or arbitrary string
  const valid = JSON.stringify(generateValidReportObject(rng));
  const cut = randInt(rng, 0, valid.length);
  return rng() < 0.5 ? valid.slice(0, cut) : generateString(rng, 60);
}

// ---------------------------------------------------------------------------
// Secret embedding generator for `redact` masking property.
// ---------------------------------------------------------------------------

interface EmbeddedSecretCase {
  readonly kind: "github-classic" | "github-fine-grained" | "stellar-seed" | "url-credential";
  readonly input: string;
  readonly secret: string;
}

const CLASSIC_GH_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] as const;
const TOKEN_DELIMITERS: readonly [string, string][] = [
  [" ", " "],
  ["\n", "\n"],
  ["\t", "\t"],
  ["=", " "],
  [": ", "\n"],
  ["(", ")"],
  ["[", "]"],
  ['"', '"'],
  ["'", "'"],
  ["<", ">"],
];

function generateEmbeddedSecretCase(rng: () => number): EmbeddedSecretCase {
  const prefixText = randomChars(rng, SURROUNDING_TEXT_CHARS, randInt(rng, 0, 25));
  const suffixText = randomChars(rng, SURROUNDING_TEXT_CHARS, randInt(rng, 0, 25));
  const [leftDelim, rightDelim] = pick(rng, TOKEN_DELIMITERS);

  const kindRoll = randInt(rng, 0, 3);
  if (kindRoll === 0) {
    const ghPrefix = pick(rng, CLASSIC_GH_PREFIXES);
    const bodyLen = randInt(rng, 36, 90);
    // Guarantee a unique secret string that won't accidentally match short surrounding text
    const secret = `${ghPrefix}${randomChars(rng, ALPHA_NUM, bodyLen)}`;
    return {
      kind: "github-classic",
      input: `${prefixText}${leftDelim}${secret}${rightDelim}${suffixText}`,
      secret,
    };
  }

  if (kindRoll === 1) {
    const bodyLen = randInt(rng, 22, 90);
    const secret = `github_pat_${randomChars(rng, ALPHA_NUM_UNDERSCORE, bodyLen)}`;
    return {
      kind: "github-fine-grained",
      input: `${prefixText}${leftDelim}${secret}${rightDelim}${suffixText}`,
      secret,
    };
  }

  if (kindRoll === 2) {
    const secret = `S${randomChars(rng, BASE32_ALPHABET, 55)}`;
    return {
      kind: "stellar-seed",
      input: `${prefixText}${leftDelim}${secret}${rightDelim}${suffixText}`,
      secret,
    };
  }

  // URL credential: userinfo (`user:secret@host`), query (`?token=secret`), or fragment (`#token=secret`)
  const scheme = rng() < 0.8 ? "https://" : "http://";
  const host = pick(rng, ["rpc.example.com", "soroban-testnet.stellar.org", "localhost:8000", "127.0.0.1:8080"]);
  const urlPath = rng() < 0.7 ? `/${randomChars(rng, ALPHA_NUM, randInt(rng, 1, 10))}` : "";
  const secretToken = `cred_${randomChars(rng, ALPHA_NUM, randInt(rng, 12, 28))}`;
  const urlSubKind = randInt(rng, 0, 3);

  let url: string;
  if (urlSubKind === 0) {
    const user = randomChars(rng, ALPHA_NUM, randInt(rng, 3, 8));
    url = `${scheme}${user}:${secretToken}@${host}${urlPath}`;
  } else if (urlSubKind === 1) {
    url = `${scheme}:${secretToken}@${host}${urlPath}`;
  } else if (urlSubKind === 2) {
    url = `${scheme}${host}${urlPath}?api_key=${secretToken}&mode=test`;
  } else {
    url = `${scheme}${host}${urlPath}#access_token=${secretToken}`;
  }

  // URL_PATTERN stops at whitespace, quotes, angle brackets, or backticks.
  const urlRightDelim = pick(rng, [" ", "\n", "\t", '"', "'", ">", "`"]);
  const urlLeftDelim = pick(rng, [" ", "\n", "\t", "=", "(", "[", '"', "'", "<"]);

  return {
    kind: "url-credential",
    input: `${prefixText}${urlLeftDelim}${url}${urlRightDelim}${suffixText}`,
    secret: secretToken,
  };
}

// ---------------------------------------------------------------------------
// Stderr generator for `extractDiagnostic`.
// ---------------------------------------------------------------------------

const ROOT_PREFIXES = [
  "error:",
  "ERROR:",
  "panic:",
  "fatal:",
  "failed to connect",
  "failure in check",
  "no checks ran:",
  "invalid fixture",
  "unknown flag",
  "unsupported protocol",
  "could not read config",
  "cannot start engine",
] as const;

function generateStderrInput(rng: () => number): string {
  const lineCount = randInt(rng, 0, 8);
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    const roll = rng();
    if (roll < 0.25) {
      // Root-diagnostic line, potentially very long (over MAX_DIAGNOSTIC_LENGTH)
      const prefix = pick(rng, ROOT_PREFIXES);
      const len = rng() < 0.4 ? randInt(rng, 520, 900) : randInt(rng, 5, 100);
      lines.push(`${prefix} ${generateString(rng, len)}`);
    } else if (roll < 0.45) {
      // Multi-byte UTF-8 and surrogate stress line
      const unit = pick(rng, ["é", "€", "🚀", "漢", "\uD800", "\uDC00", "::error::", "`code`"]);
      lines.push(`${pick(rng, ROOT_PREFIXES)} ${unit.repeat(randInt(rng, 10, 180))}`);
    } else if (roll < 0.65) {
      // Blank / whitespace / control-char line
      lines.push(randomChars(rng, " \t\r\u0000\u0007\u001b", randInt(rng, 0, 16)));
    } else {
      // Ordinary progress/context line
      lines.push(`progress step ${String(i)}: ${generateString(rng, randInt(rng, 0, 100))}`);
    }
  }
  return lines.join(rng() < 0.3 ? "\r\n" : "\n");
}

// ---------------------------------------------------------------------------
// Known-defects evaluation logic (#442 Policy for failures).
// ---------------------------------------------------------------------------

function loadKnownDefects(filePath: string = KNOWN_DEFECTS_PATH): readonly KnownDefectEntry[] {
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`Expected ${filePath} to contain a JSON array of known-defect entries.`);
  }
  return raw as KnownDefectEntry[];
}

/**
 * Evaluates a single known-defect entry.
 *
 * - Fails if required metadata (`property`, `input`, `observed`, `expected`,
 *   or a valid GitHub `issue` URL) is missing.
 * - Fails with a promotion message when the recorded wrong behaviour disappears
 *   (the defect is fixed), forcing the fixer to move the case into the enforced
 *   properties and delete the entry from `tests/fixtures/property-known-defects.json`.
 * - Fails if the observed wrong behaviour drifted to a different wrong output.
 */
export function evaluateKnownDefect(entry: KnownDefectEntry): void {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("Known-defect entry must be an object.");
  }
  if (typeof entry.property !== "string" || !VALID_PROPERTIES.has(entry.property)) {
    throw new Error(
      `Known-defect entry has an invalid "property" field: ${JSON.stringify(entry.property)}.`,
    );
  }
  if (typeof entry.input !== "string") {
    throw new Error(`Known-defect entry for "${entry.property}" is missing a string "input".`);
  }
  if (typeof entry.observed !== "string" || entry.observed === "") {
    throw new Error(
      `Known-defect entry for "${entry.property}" on input ${JSON.stringify(entry.input)} is missing a non-empty "observed" output.`,
    );
  }
  if (typeof entry.expected !== "string" || entry.expected === "") {
    throw new Error(
      `Known-defect entry for "${entry.property}" on input ${JSON.stringify(entry.input)} is missing a non-empty "expected" behaviour.`,
    );
  }
  if (typeof entry.issue !== "string" || !ISSUE_URL_PATTERN.test(entry.issue)) {
    throw new Error(
      `Known-defect entry for "${entry.property}" on input ${JSON.stringify(entry.input)} must include a valid tracking "issue" URL (got ${JSON.stringify(entry.issue)}).`,
    );
  }
  if (entry.observed === entry.expected) {
    throw new Error(
      `Known-defect entry for "${entry.property}" on input ${JSON.stringify(entry.input)} has identical "observed" and "expected" values.`,
    );
  }

  let actual: string;
  let isFixed: boolean;

  switch (entry.property) {
    case "redact-idempotence": {
      const once = redact(entry.input);
      const twice = redact(once);
      actual = twice;
      isFixed = twice === once || twice === entry.expected;
      break;
    }
    case "redact-masking": {
      actual = redact(entry.input);
      isFixed = actual === entry.expected;
      break;
    }
    case "extractDiagnostic": {
      actual = extractDiagnostic(entry.input);
      isFixed =
        actual === entry.expected &&
        actual.length <= MAX_DIAGNOSTIC_LENGTH &&
        Buffer.byteLength(actual, "utf8") <= MAX_DIAGNOSTIC_LENGTH;
      break;
    }
    case "parseReport": {
      try {
        const parsed = parseReport(entry.input);
        actual = `returned:${JSON.stringify(parsed)}`;
      } catch (error) {
        const name = error instanceof Error ? error.constructor.name : typeof error;
        actual = `threw:${name}`;
      }
      isFixed = actual === entry.expected;
      break;
    }
  }

  if (isFixed) {
    throw new Error(
      `Known defect for "${entry.property}" on input ${JSON.stringify(entry.input)} (${entry.issue}) ` +
        `no longer reproduces (observed ${JSON.stringify(actual)}, expected ${JSON.stringify(entry.expected)}). ` +
        `Move this case into the enforced properties in tests/unit/properties.test.ts and delete the entry from tests/fixtures/property-known-defects.json.`,
    );
  }

  if (actual !== entry.observed) {
    throw new Error(
      `Known defect for "${entry.property}" on input ${JSON.stringify(entry.input)} (${entry.issue}) ` +
        `changed its wrong behaviour: recorded observed=${JSON.stringify(entry.observed)}, got actual=${JSON.stringify(actual)}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Property runners (parameterised by seed for deterministic reproduction).
// ---------------------------------------------------------------------------

function runParseReportProperty(seed: number, iterations = PARSE_REPORT_ITERATIONS): void {
  const rng = mulberry32(seed);
  let acceptedCount = 0;
  let rejectedCount = 0;

  for (let i = 0; i < iterations; i += 1) {
    const input = generateParseReportInput(rng, i);
    try {
      const parsed = parseReport(input);
      acceptedCount += 1;

      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(
          `parseReport returned a non-object for input=${JSON.stringify(input)} (SEED=${String(seed)})`,
        );
      }
      if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        throw new Error(
          `parseReport returned unsupported schemaVersion=${String(parsed.schemaVersion)} for input=${JSON.stringify(input)} (SEED=${String(seed)})`,
        );
      }
      // Deterministic on second call
      const parsedAgain = parseReport(input);
      if (JSON.stringify(parsed) !== JSON.stringify(parsedAgain)) {
        throw new Error(
          `parseReport is not deterministic for input=${JSON.stringify(input)} (SEED=${String(seed)})`,
        );
      }
    } catch (error) {
      rejectedCount += 1;
      if (!(error instanceof InvalidReportError) || !isCanaryActionError(error)) {
        const errName = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
        throw new Error(
          `parseReport threw unexpected error (${errName}) at iteration ${String(i)} ` +
            `for input=${JSON.stringify(input)} (reproduce with SEED=${String(seed)} npm test)`,
        );
      }
    }
  }

  expect(acceptedCount + rejectedCount).toBe(iterations);
  expect(acceptedCount).toBeGreaterThan(0);
  expect(rejectedCount).toBeGreaterThan(0);
}

function runRedactIdempotenceProperty(
  seed: number,
  knownDefects: readonly KnownDefectEntry[],
  iterations = REDACT_IDEMPOTENCE_ITERATIONS,
): void {
  const rng = mulberry32(seed);
  const recordedInputs = new Set(
    knownDefects.filter((d) => d.property === "redact-idempotence").map((d) => d.input),
  );

  // 1. At least `iterations` generated strings hold redact(redact(x)) === redact(x) directly.
  for (let i = 0; i < iterations; i += 1) {
    const input = generateIdempotentSafeString(rng);
    const once = redact(input);
    const twice = redact(once);
    if (twice !== once) {
      const minimal = shrinkString(input, (candidate) => redact(redact(candidate)) !== redact(candidate));
      throw new Error(
        `redact(redact(x)) !== redact(x) at iteration ${String(i)} ` +
          `input=${JSON.stringify(input)} minimal=${JSON.stringify(minimal)} ` +
          `once=${JSON.stringify(once)} twice=${JSON.stringify(twice)} ` +
          `(reproduce with SEED=${String(seed)} npm test)`,
      );
    }
  }

  // 2. Unconstrained strings (including backticks and arbitrary colon runs):
  // every failure must shrink to a minimal counterexample recorded in
  // tests/fixtures/property-known-defects.json; an unrecorded defect fails loudly.
  let shrunkOnce = false;
  for (let i = 0; i < iterations; i += 1) {
    const input = generateString(rng, 45);
    const once = redact(input);
    const twice = redact(once);
    if (twice !== once) {
      if (!shrunkOnce || recordedInputs.size === 0) {
        shrunkOnce = true;
        const minimal = shrinkString(input, (candidate) => redact(redact(candidate)) !== redact(candidate));
        if (!recordedInputs.has(minimal)) {
          throw new Error(
            `Unrecorded redact idempotence failure at iteration ${String(i)}: ` +
              `input=${JSON.stringify(input)} shrunk=${JSON.stringify(minimal)} ` +
              `once=${JSON.stringify(once)} twice=${JSON.stringify(twice)} ` +
              `(reproduce with SEED=${String(seed)} npm test)`,
          );
        }
      }
      // Verify that neutralizing only the recorded known-defect inputs in `input`
      // restores idempotence; if not, shrink and report the unrecorded defect.
      let neutralized = input;
      if (recordedInputs.has("`")) {
        neutralized = neutralized.replace(/`/g, "'");
      }
      if (recordedInputs.has(":::")) {
        neutralized = neutralized.replace(/:{3,}/g, "::");
      }
      const cleanOnce = redact(neutralized);
      const cleanTwice = redact(cleanOnce);
      if (cleanTwice !== cleanOnce) {
        const minimal = shrinkString(
          neutralized,
          (candidate) => redact(redact(candidate)) !== redact(candidate),
        );
        if (!recordedInputs.has(minimal)) {
          throw new Error(
            `Unrecorded redact idempotence failure at iteration ${String(i)}: ` +
              `input=${JSON.stringify(input)} shrunk=${JSON.stringify(minimal)} ` +
              `once=${JSON.stringify(cleanOnce)} twice=${JSON.stringify(cleanTwice)} ` +
              `(reproduce with SEED=${String(seed)} npm test)`,
          );
        }
      }
    }
  }
}

function runRedactMaskingProperty(seed: number, iterations = REDACT_MASKING_ITERATIONS): void {
  const rng = mulberry32(seed);
  const countsByKind: Record<EmbeddedSecretCase["kind"], number> = {
    "github-classic": 0,
    "github-fine-grained": 0,
    "stellar-seed": 0,
    "url-credential": 0,
  };

  for (let i = 0; i < iterations; i += 1) {
    const testCase = generateEmbeddedSecretCase(rng);
    countsByKind[testCase.kind] += 1;
    const output = redact(testCase.input);

    if (output.includes(testCase.secret) || !output.includes(REDACTED)) {
      throw new Error(
        `redact failed to mask ${testCase.kind} at iteration ${String(i)}: ` +
          `secret=${JSON.stringify(testCase.secret)} input=${JSON.stringify(testCase.input)} ` +
          `output=${JSON.stringify(output)} (reproduce with SEED=${String(seed)} npm test)`,
      );
    }
  }

  expect(countsByKind["github-classic"]).toBeGreaterThan(0);
  expect(countsByKind["github-fine-grained"]).toBeGreaterThan(0);
  expect(countsByKind["stellar-seed"]).toBeGreaterThan(0);
  expect(countsByKind["url-credential"]).toBeGreaterThan(0);
}

function runExtractDiagnosticProperty(seed: number, iterations = EXTRACT_DIAGNOSTIC_ITERATIONS): void {
  const rng = mulberry32(seed);
  let truncatedOrMaxCount = 0;

  for (let i = 0; i < iterations; i += 1) {
    const stderr = generateStderrInput(rng);
    const first = extractDiagnostic(stderr);
    const second = extractDiagnostic(stderr);

    if (first !== second) {
      throw new Error(
        `extractDiagnostic is not deterministic at iteration ${String(i)} ` +
          `for input=${JSON.stringify(stderr)} first=${JSON.stringify(first)} second=${JSON.stringify(second)} ` +
          `(reproduce with SEED=${String(seed)} npm test)`,
      );
    }

    const byteLength = Buffer.byteLength(first, "utf8");
    if (first.length > MAX_DIAGNOSTIC_LENGTH || byteLength > MAX_DIAGNOSTIC_LENGTH) {
      throw new Error(
        `extractDiagnostic exceeded MAX_DIAGNOSTIC_LENGTH (${String(MAX_DIAGNOSTIC_LENGTH)}) at iteration ${String(i)}: ` +
          `chars=${String(first.length)} bytes=${String(byteLength)} ` +
          `input=${JSON.stringify(stderr)} output=${JSON.stringify(first)} ` +
          `(reproduce with SEED=${String(seed)} npm test)`,
      );
    }

    if (byteLength === MAX_DIAGNOSTIC_LENGTH || first.startsWith("[... earlier output truncated ...]")) {
      truncatedOrMaxCount += 1;
    }
  }

  expect(truncatedOrMaxCount).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("deterministic property tests (#442)", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it(`parseReport handles ${String(PARSE_REPORT_ITERATIONS)} generated JSON values and only ever throws InvalidReportError (SEED=${String(SEED)})`, () => {
    expect(PARSE_REPORT_ITERATIONS).toBeGreaterThanOrEqual(1_000);
    runParseReportProperty(SEED, PARSE_REPORT_ITERATIONS);
  });

  it(`redact is idempotent across ${String(REDACT_IDEMPOTENCE_ITERATIONS)} generated strings or shrinks to a recorded known defect (SEED=${String(SEED)})`, () => {
    expect(REDACT_IDEMPOTENCE_ITERATIONS).toBeGreaterThanOrEqual(500);
    const knownDefects = loadKnownDefects();
    runRedactIdempotenceProperty(SEED, knownDefects, REDACT_IDEMPOTENCE_ITERATIONS);
  });

  it(`redact masks GitHub tokens, Stellar secret seeds, and URL credentials embedded in surrounding text across ${String(REDACT_MASKING_ITERATIONS)} generated cases (SEED=${String(SEED)})`, () => {
    expect(REDACT_MASKING_ITERATIONS).toBeGreaterThanOrEqual(500);
    runRedactMaskingProperty(SEED, REDACT_MASKING_ITERATIONS);
  });

  it(`extractDiagnostic never exceeds MAX_DIAGNOSTIC_LENGTH (${String(MAX_DIAGNOSTIC_LENGTH)}) and is deterministic across ${String(EXTRACT_DIAGNOSTIC_ITERATIONS)} generated inputs (SEED=${String(SEED)})`, () => {
    expect(EXTRACT_DIAGNOSTIC_ITERATIONS).toBeGreaterThanOrEqual(500);
    runExtractDiagnosticProperty(SEED, EXTRACT_DIAGNOSTIC_ITERATIONS);
  });

  it("known-defects guard: every entry in tests/fixtures/property-known-defects.json is well-formed and still reproduces", () => {
    const entries = loadKnownDefects();
    for (const entry of entries) {
      evaluateKnownDefect(entry);
    }
  });

  describe("seed handling and negative guard tests", () => {
    it("reads the fixed default seed and allows SEED to override it", () => {
      expect(readSeed(undefined)).toBe(DEFAULT_SEED);
      expect(readSeed("")).toBe(DEFAULT_SEED);
      expect(readSeed("12345")).toBe(12345);
      expect(() => readSeed("-1")).toThrow(/SEED must be an integer/);
      expect(() => readSeed("not-a-number")).toThrow(/SEED must be an integer/);
    });

    it("reproduces the exact same failure message and failing input when re-run with the same seed", () => {
      const failingSeed = 987654321;
      let firstFailure = "";
      let secondFailure = "";

      // Run with an empty known-defects list so the first generated string with
      // a backtick or `:::` triggers a failure.
      try {
        runRedactIdempotenceProperty(failingSeed, [], 200);
      } catch (error) {
        firstFailure = error instanceof Error ? error.message : String(error);
      }

      try {
        runRedactIdempotenceProperty(failingSeed, [], 200);
      } catch (error) {
        secondFailure = error instanceof Error ? error.message : String(error);
      }

      expect(firstFailure).not.toBe("");
      expect(firstFailure).toContain(`SEED=${String(failingSeed)}`);
      expect(secondFailure).toBe(firstFailure);
    });

    it("fails the guard test when a known-defect entry has no valid issue link", () => {
      const missingIssueEntry: KnownDefectEntry = {
        property: "redact-idempotence",
        input: "`",
        observed: "\\\\`",
        expected: "\\`",
        issue: "",
      };
      expect(() => evaluateKnownDefect(missingIssueEntry)).toThrow(/valid tracking "issue" URL/);

      const relativeIssueEntry: KnownDefectEntry = {
        ...missingIssueEntry,
        issue: "#442",
      };
      expect(() => evaluateKnownDefect(relativeIssueEntry)).toThrow(/valid tracking "issue" URL/);
    });

    it("fails the guard test and tells the fixer to promote the entry when the recorded wrong behaviour disappears", () => {
      const fixedEntry: KnownDefectEntry = {
        property: "redact-idempotence",
        input: "ordinary log line without backticks",
        observed: "wrong-non-idempotent-output",
        expected: "ordinary log line without backticks",
        issue: "https://github.com/StellarCanary/ProtocolCanary-Action/issues/442",
      };
      expect(() => evaluateKnownDefect(fixedEntry)).toThrow(
        /Move this case into the enforced properties in tests\/unit\/properties\.test\.ts and delete the entry from tests\/fixtures\/property-known-defects\.json/,
      );
    });
  });
});
