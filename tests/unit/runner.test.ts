import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CanaryExecutionFailedError, TimeoutError } from "../../src/errors";
import { ActionInputs } from "../../src/inputs";
import { buildCheckArgs, runCheck } from "../../src/runner";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// Most tests exercise the real mock-canary fixture, so `spawn` defaults to a
// pass-through of the real implementation; the timeout-escalation tests below
// swap in a fake child via `mockImplementationOnce`.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

/** A `child_process.spawn` result that does nothing until it is signalled. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  /** Whether the fake process exits in response to `SIGTERM` (rather than ignoring it). */
  constructor(private readonly exitsOnSigterm: boolean) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    const exits = this.exitsOnSigterm ? signal === "SIGTERM" : signal === "SIGKILL";
    if (exits) {
      this.emit("close", null, signal);
    }
    return true;
  }
}

const MOCK_CANARY = path.join(__dirname, "..", "fixtures", "mock-canary.cjs");

const BASE_INPUTS: ActionInputs = {
  protocol: 28,
  config: undefined,
  network: undefined,
  rpcUrl: undefined,
  fixturesDir: "fixtures",
  version: "0.1.0",
  uploadReport: true,
  annotations: true,
  timeoutMinutes: 15,
};

describe("buildCheckArgs", () => {
  it("always requests JSON output and the fixtures directory", () => {
    const args = buildCheckArgs(BASE_INPUTS);
    expect(args).toEqual(["check", "--format", "json", "--protocol", "28", "--fixtures-dir", "fixtures"]);
  });

  it("omits optional flags that were not provided", () => {
    const args = buildCheckArgs({ ...BASE_INPUTS, protocol: undefined });
    expect(args).not.toContain("--protocol");
  });

  it("omits --network specifically when only network is left unset", () => {
    // Every optional flag is guarded by its own independent `if` in
    // `buildCheckArgs`, so a refactor that starts always pushing --network
    // (e.g. as an empty string) must still be caught here, with the other
    // optional inputs deliberately left set.
    const args = buildCheckArgs({
      ...BASE_INPUTS,
      network: undefined,
      rpcUrl: "https://soroban-testnet.stellar.org",
      config: ".stellar-canary.toml",
    });
    expect(args).not.toContain("--network");
    expect(args).not.toContain("");
    // The flags that *were* provided are still forwarded, so this cannot
    // pass by an implementation that drops every optional argument.
    expect(args).toEqual(
      expect.arrayContaining([
        "--protocol",
        "28",
        "--rpc-url",
        "https://soroban-testnet.stellar.org",
        "--config",
        ".stellar-canary.toml",
      ]),
    );
  });

  it("forwards network, rpc-url, and config as separate arguments", () => {
    const args = buildCheckArgs({
      ...BASE_INPUTS,
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      config: ".stellar-canary.toml",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "testnet",
        "--rpc-url",
        "https://soroban-testnet.stellar.org",
        "--config",
        ".stellar-canary.toml",
      ]),
    );
  });

  it("never concatenates arguments into a single string (command-injection defense)", () => {
    const args = buildCheckArgs({ ...BASE_INPUTS, network: "testnet; rm -rf /" });
    // The dangerous value must appear as exactly one array element, never
    // merged with adjacent flags or split by the shell.
    expect(args).toContain("testnet; rm -rf /");
    expect(args.some((a) => a.includes("--network testnet"))).toBe(false);
  });
});

describe("runCheck", () => {
  function run(timeoutMs = 5000) {
    return runCheck(MOCK_CANARY, ["check"], timeoutMs);
  }

  it("captures stdout and a zero exit code on pass", async () => {
    process.env.MOCK_CANARY_SCENARIO = "pass";
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "pass" });
    expect(result.stderr).toBe("");
  });

  it("preserves a non-zero exit code without throwing", async () => {
    process.env.MOCK_CANARY_SCENARIO = "fail";
    const result = await run();
    expect(result.exitCode).toBe(1);
  });

  it("captures stderr separately when there is no JSON on stdout", async () => {
    process.env.MOCK_CANARY_SCENARIO = "config-error";
    const result = await run();
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("configuration error");
  });

  it("rejects with TimeoutError and kills the process when it runs too long", async () => {
    process.env.MOCK_CANARY_SCENARIO = "timeout";
    await expect(runCheck(MOCK_CANARY, ["check"], 200)).rejects.toThrow(TimeoutError);
  });

  it("rejects with CanaryExecutionFailedError when the binary cannot be started", async () => {
    await expect(runCheck(path.join(__dirname, "does-not-exist"), ["check"], 5000)).rejects.toThrow(
      CanaryExecutionFailedError,
    );
  });
});

describe("runCheck signal handling", () => {
  it("resolves with a null exit code and the signal when the child is killed by a signal", async () => {
    // This exercises the `close` branch where `exitCode` is null and a real
    // signal is set, without going through the timeout path: the child
    // terminates itself with SIGTERM.
    const result = await runCheck(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], 5000);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("forwards a cancellation signal to the child and removes its listeners on settle", async () => {
    process.env.MOCK_CANARY_SCENARIO = "timeout";
    const baselineInt = process.listenerCount("SIGINT");
    const baselineTerm = process.listenerCount("SIGTERM");

    // runCheck registers its signal-forwarding listeners synchronously
    // inside the promise executor, so they are present the moment it returns.
    const pending = runCheck(MOCK_CANARY, ["check"], 8000);
    expect(process.listenerCount("SIGINT")).toBe(baselineInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm + 1);

    // Invoke the forwarding listener the way the OS would, proving the
    // signal reaches the child: the child dies from SIGINT, so the close
    // event reports a null exit code with the signal set and runCheck
    // resolves rather than rejecting.
    const listeners = process.rawListeners("SIGINT");
    const forwardSignal = listeners[listeners.length - 1] as (signal: NodeJS.Signals) => void;
    forwardSignal("SIGINT");

    const result = await pending;
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGINT");

    // cleanup() removed both forwarding listeners: no leak across runs.
    expect(process.listenerCount("SIGINT")).toBe(baselineInt);
    expect(process.listenerCount("SIGTERM")).toBe(baselineTerm);
  });
});

describe("runCheck timeout escalation", () => {
  afterEach(() => {
    spawnMock.mockClear();
  });

  function fakeSpawn(child: FakeChild): void {
    spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);
  }

  it("sends SIGKILL when the process ignores SIGTERM past the grace period", async () => {
    const child = new FakeChild(false);
    fakeSpawn(child);

    await expect(runCheck("fake-canary", ["check"], 10, 20)).rejects.toThrow(TimeoutError);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("never sends SIGKILL when the process exits after SIGTERM", async () => {
    const child = new FakeChild(true);
    fakeSpawn(child);

    await expect(runCheck("fake-canary", ["check"], 10, 20)).rejects.toThrow(TimeoutError);
    // Wait beyond the grace period: the escalation timer must have been
    // cleared when the process closed, or SIGKILL would appear here.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(child.signals).toEqual(["SIGTERM"]);
  });
});
