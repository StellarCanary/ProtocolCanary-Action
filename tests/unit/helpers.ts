import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanaryReport, CanaryResult } from "../../src/output";

/**
 * Tracks temporary directories created during test runs and ensures
 * they are removed cleanly afterwards with Windows-compatible retry options.
 */
export class TempDirTracker {
  private readonly dirs = new Set<string>();

  /**
   * Records a temporary directory path to be cleaned up.
   */
  track(dirPath: string): string {
    this.dirs.add(dirPath);
    return dirPath;
  }

  /**
   * Removes all tracked directories.
   */
  cleanup(): void {
    for (const dir of Array.from(this.dirs)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Ignore errors if directory is already removed
      }
      this.dirs.delete(dir);
    }
  }

  /**
   * Checks if a directory is tracked.
   */
  has(dirPath: string): boolean {
    return this.dirs.has(dirPath);
  }

  /**
   * Returns the count of tracked directories.
   */
  get size(): number {
    return this.dirs.size;
  }
}

/**
 * Shared builders for CanaryReport/CanaryResult test fixtures.
 *
 * Previously each of annotations.test.ts, summary.test.ts, and
 * output.test.ts defined its own near-identical local copy; a schema change
 * (e.g. a new required top-level field) meant updating three places that
 * could silently drift. Import these instead.
 */
export function result(overrides: Partial<CanaryResult> = {}): CanaryResult {
  return {
    testId: "t",
    protocol: 28,
    surface: "xdr",
    status: "pass",
    summary: "ok",
    durationMs: 1,
    fixtureId: "t",
    ...overrides,
  };
}

export function report(resultsOrOverrides: CanaryResult[] | Partial<CanaryReport> = {}): CanaryReport {
  const defaults: CanaryReport = {
    schemaVersion: 1,
    toolVersion: "0.1.0",
    targetProtocol: 28,
    project: { name: "example-project", type: "soroban" },
    status: "pass",
    counts: { total: 0, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
    results: [],
    git: { commit: null, branch: null, isDirty: null },
  };
  if (Array.isArray(resultsOrOverrides)) {
    const results = resultsOrOverrides;
    return {
      ...defaults,
      counts: { total: results.length, passed: 0, failed: 0, warnings: 0, errors: 0, skipped: 0 },
      results,
    };
  }
  return { ...defaults, ...resultsOrOverrides };
}

/**
 * Common GitHub Actions input and runner environment variables consumed by
 * this Action (e.g., `src/inputs.ts` and `src/canary.ts`).
 */
export const COMMON_ACTION_INPUT_ENV_VARS = [
  "INPUT_PROTOCOL",
  "INPUT_CONFIG",
  "INPUT_WORKING-DIRECTORY",
  "INPUT_NETWORK",
  "INPUT_RPC-URL",
  "INPUT_FIXTURES-DIR",
  "INPUT_VERSION",
  "INPUT_UPLOAD-REPORT",
  "INPUT_ANNOTATIONS",
  "INPUT_GITHUB-TOKEN",
  "GITHUB_TOKEN",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
] as const;

/**
 * Maps a GitHub Action input name (for example `fixtures-dir`) to the
 * `INPUT_*` environment variable name that `@actions/core`'s `getInput()` reads.
 */
export function actionInputEnvKey(inputName: string): string {
  return `INPUT_${inputName.replace(/ /g, "_").toUpperCase()}`;
}

/** Map of environment variable overrides (`undefined` unsets the variable). */
export type EnvOverrides = Readonly<Record<string, string | undefined>>;

/**
 * Captures and restores `process.env` entries mutated during a test so
 * temporary values never leak across test cases, even when a test throws.
 */
export class EnvSnapshot {
  private readonly originals = new Map<string, string | undefined>();

  /** Records the initial value of each key if it has not been captured yet. */
  capture(keys: Iterable<string>): void {
    for (const key of keys) {
      if (!this.originals.has(key)) {
        this.originals.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
      }
    }
  }

  /** Captures `key` if needed, then sets or deletes `process.env[key]`. */
  set(key: string, value: string | undefined): void {
    this.capture([key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  /** Applies every entry in `overrides` while recording its original value. */
  apply(overrides: EnvOverrides): void {
    for (const [key, value] of Object.entries(overrides)) {
      this.set(key, value);
    }
  }

  /** Restores all captured environment variables and clears tracked state. */
  restore(): void {
    for (const [key, original] of this.originals.entries()) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    this.originals.clear();
  }

  /** Returns true when `key` is currently tracked for restoration. */
  has(key: string): boolean {
    return this.originals.has(key);
  }

  /** Returns the number of tracked environment variables. */
  get size(): number {
    return this.originals.size;
  }
}

/**
 * Runs `fn` with temporary `process.env` overrides and restores the previous
 * values in a `finally` block (supporting both synchronous and async callbacks).
 */
export function withIsolatedEnv<T>(overrides: EnvOverrides, fn: () => T): T {
  const snapshot = new EnvSnapshot();
  snapshot.apply(overrides);
  let settledAsync = false;
  try {
    const outcome = fn();
    if (outcome instanceof Promise) {
      settledAsync = true;
      return outcome.finally(() => {
        snapshot.restore();
      }) as T;
    }
    return outcome;
  } finally {
    if (!settledAsync) {
      snapshot.restore();
    }
  }
}

/**
 * Runs `fn` with temporary GitHub Action `INPUT_*` environment variables and
 * restores all touched keys on completion or error.
 */
export function withActionInputs<T>(inputs: EnvOverrides, fn: () => T): T {
  const overrides: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(inputs)) {
    overrides[actionInputEnvKey(name)] = value;
  }
  return withIsolatedEnv(overrides, fn);
}

/**
 * #674: environment variable isolation coverage for test helpers.
 *
 * The issue scopes changes strictly to `tests/unit/helpers.ts`, so these
 * assertions live alongside the helpers (matching #673 in
 * `tests/helpers/fresh-build.ts`). Vitest registers and executes them
 * whenever any unit test suite imports `./helpers`.
 */
describe("environment variable isolation (#674)", () => {
  const EXISTING_KEY = "CANARY_HELPER_TEST_EXISTING";
  const EMPTY_KEY = "CANARY_HELPER_TEST_EMPTY";
  const TEMPORARY_KEY = "CANARY_HELPER_TEST_TEMP";
  const ADJACENT_LEAK_KEY = "CANARY_HELPER_TEST_ADJACENT_LEAK";

  const hookSnapshot = new EnvSnapshot();

  beforeEach(() => {
    hookSnapshot.capture([
      EXISTING_KEY,
      EMPTY_KEY,
      TEMPORARY_KEY,
      ADJACENT_LEAK_KEY,
      ...COMMON_ACTION_INPUT_ENV_VARS,
    ]);
  });

  afterEach(() => {
    hookSnapshot.restore();
  });

  it("restores pre-existing, empty, deleted, and added variables after normal completion", () => {
    process.env[EXISTING_KEY] = "original-value";
    process.env[EMPTY_KEY] = "";
    delete process.env[TEMPORARY_KEY];

    const observed = withIsolatedEnv(
      {
        [EXISTING_KEY]: "mutated-value",
        [EMPTY_KEY]: undefined,
        [TEMPORARY_KEY]: "transient-value",
      },
      () => ({
        existing: process.env[EXISTING_KEY],
        empty: process.env[EMPTY_KEY],
        temporary: process.env[TEMPORARY_KEY],
      }),
    );

    expect(observed).toEqual({
      existing: "mutated-value",
      empty: undefined,
      temporary: "transient-value",
    });
    expect(process.env[EXISTING_KEY]).toBe("original-value");
    expect(process.env[EMPTY_KEY]).toBe("");
    expect(Object.prototype.hasOwnProperty.call(process.env, TEMPORARY_KEY)).toBe(false);
  });

  it("restores mutated environment variables when a synchronous exception is thrown", () => {
    process.env[EXISTING_KEY] = "before-sync-error";
    delete process.env[TEMPORARY_KEY];

    expect(() =>
      withIsolatedEnv(
        {
          [EXISTING_KEY]: "corrupted-before-throw",
          [TEMPORARY_KEY]: "leaked-before-throw",
        },
        () => {
          expect(process.env[EXISTING_KEY]).toBe("corrupted-before-throw");
          expect(process.env[TEMPORARY_KEY]).toBe("leaked-before-throw");
          throw new Error("simulated synchronous failure");
        },
      ),
    ).toThrow("simulated synchronous failure");

    expect(process.env[EXISTING_KEY]).toBe("before-sync-error");
    expect(Object.prototype.hasOwnProperty.call(process.env, TEMPORARY_KEY)).toBe(false);
  });

  it("restores mutated environment variables when an asynchronous callback rejects", async () => {
    process.env[EXISTING_KEY] = "before-async-error";
    delete process.env[TEMPORARY_KEY];

    await expect(
      withIsolatedEnv(
        {
          [EXISTING_KEY]: "corrupted-async",
          [TEMPORARY_KEY]: "leaked-async",
        },
        async () => {
          await Promise.resolve();
          expect(process.env[EXISTING_KEY]).toBe("corrupted-async");
          expect(process.env[TEMPORARY_KEY]).toBe("leaked-async");
          throw new Error("simulated async failure");
        },
      ),
    ).rejects.toThrow("simulated async failure");

    expect(process.env[EXISTING_KEY]).toBe("before-async-error");
    expect(Object.prototype.hasOwnProperty.call(process.env, TEMPORARY_KEY)).toBe(false);
  });

  it("preserves the first captured value across repeated mutations in EnvSnapshot", () => {
    process.env[EXISTING_KEY] = "initial";
    const localSnapshot = new EnvSnapshot();

    try {
      localSnapshot.set(EXISTING_KEY, "first-mutation");
      localSnapshot.set(EXISTING_KEY, "second-mutation");
      localSnapshot.set(TEMPORARY_KEY, "temp-1");
      localSnapshot.set(TEMPORARY_KEY, "temp-2");
      expect(localSnapshot.has(EXISTING_KEY)).toBe(true);
      expect(localSnapshot.size).toBe(2);
      expect(process.env[EXISTING_KEY]).toBe("second-mutation");
    } finally {
      localSnapshot.restore();
    }

    expect(localSnapshot.size).toBe(0);
    expect(process.env[EXISTING_KEY]).toBe("initial");
    expect(Object.prototype.hasOwnProperty.call(process.env, TEMPORARY_KEY)).toBe(false);
  });

  it("sets temporary values inside one test without leaking to the next test (step 1)", () => {
    hookSnapshot.set(ADJACENT_LEAK_KEY, "ephemeral-step-1");
    expect(process.env[ADJACENT_LEAK_KEY]).toBe("ephemeral-step-1");
  });

  it("does not observe temporary values from an adjacent test execution (step 2)", () => {
    expect(process.env[ADJACENT_LEAK_KEY]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(process.env, ADJACENT_LEAK_KEY)).toBe(false);
  });

  it("isolates and restores common Action input environment variables across errors", () => {
    const preExistingInput = process.env.INPUT_PROTOCOL;
    const preExistingVersion = process.env.INPUT_VERSION;
    const preExistingFixturesDir = process.env["INPUT_FIXTURES-DIR"];
    const preExistingUploadReport = process.env["INPUT_UPLOAD-REPORT"];
    const preExistingGithubTokenInput = process.env["INPUT_GITHUB-TOKEN"];
    const preExistingRunnerTemp = process.env.RUNNER_TEMP;

    expect(COMMON_ACTION_INPUT_ENV_VARS).toContain(actionInputEnvKey("protocol"));
    expect(COMMON_ACTION_INPUT_ENV_VARS).toContain(actionInputEnvKey("version"));
    expect(COMMON_ACTION_INPUT_ENV_VARS).toContain(actionInputEnvKey("fixtures-dir"));
    expect(COMMON_ACTION_INPUT_ENV_VARS).toContain(actionInputEnvKey("upload-report"));
    expect(COMMON_ACTION_INPUT_ENV_VARS).toContain(actionInputEnvKey("github-token"));
    expect(actionInputEnvKey("upload report")).toBe("INPUT_UPLOAD_REPORT");

    expect(() =>
      withActionInputs(
        {
          protocol: "28",
          version: "0.2.0",
          "fixtures-dir": "tests/fixtures/sample",
          "upload-report": "false",
          "github-token": "stub-token-value",
        },
        () =>
          withIsolatedEnv({ RUNNER_TEMP: "/tmp/canary-isolated-runner" }, () => {
            expect(process.env.INPUT_PROTOCOL).toBe("28");
            expect(process.env.INPUT_VERSION).toBe("0.2.0");
            expect(process.env["INPUT_FIXTURES-DIR"]).toBe("tests/fixtures/sample");
            expect(process.env["INPUT_UPLOAD-REPORT"]).toBe("false");
            expect(process.env["INPUT_GITHUB-TOKEN"]).toBe("stub-token-value");
            expect(process.env.RUNNER_TEMP).toBe("/tmp/canary-isolated-runner");
            throw new Error("simulated action input error");
          }),
      ),
    ).toThrow("simulated action input error");

    expect(process.env.INPUT_PROTOCOL).toBe(preExistingInput);
    expect(process.env.INPUT_VERSION).toBe(preExistingVersion);
    expect(process.env["INPUT_FIXTURES-DIR"]).toBe(preExistingFixturesDir);
    expect(process.env["INPUT_UPLOAD-REPORT"]).toBe(preExistingUploadReport);
    expect(process.env["INPUT_GITHUB-TOKEN"]).toBe(preExistingGithubTokenInput);
    expect(process.env.RUNNER_TEMP).toBe(preExistingRunnerTemp);
  });
});
