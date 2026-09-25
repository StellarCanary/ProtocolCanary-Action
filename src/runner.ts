import { spawn } from "node:child_process";

import { ActionInputs } from "./inputs";
import { CanaryExecutionFailedError, TimeoutError } from "./errors";

/**
 * Result of running `stellar-canary check`.
 * `exitCode` and `signal` are complementary: when the process is
 * terminated by a signal, Node sets `exitCode` to `null` and populates
 * `signal` with the terminating signal. `src/main.ts` interprets
 * `execution.exitCode === null` as an execution failure caused by a signal.
 * For a normal exit, `signal` is `null` and `exitCode` contains the process
 * status code.
 */
export interface CheckExecutionResult {
  /** Exit status for a normal process exit; `null` if terminated by a signal. */
  readonly exitCode: number | null;
  /** Signal that terminated the process, or `null` for a normal exit. */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Builds the `stellar-canary check` argument array from validated inputs.
 * Arguments are always passed as an array — never interpolated into a
 * shell string — so nothing in an input can be interpreted as a shell
 * operator (see SECURITY.md).
 *
 * `--format json` is always requested, regardless of any future `format`
 * input: the Action needs structured data to build the job summary and
 * annotations from, and running Canary a second time to get a different
 * format is explicitly out of scope (one invocation drives everything).
 */
export function buildCheckArgs(inputs: ActionInputs): string[] {
  const args = ["check", "--format", "json"];

  if (inputs.protocol !== undefined) {
    args.push("--protocol", String(inputs.protocol));
  }
  if (inputs.network !== undefined) {
    args.push("--network", inputs.network);
  }
  if (inputs.rpcUrl !== undefined) {
    args.push("--rpc-url", inputs.rpcUrl);
  }
  if (inputs.config !== undefined) {
    args.push("--config", inputs.config);
  }
  args.push("--fixtures-dir", inputs.fixturesDir);

  return args;
}

const SIGNALS_TO_FORWARD: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * How long a timed-out Canary process is given to exit after `SIGTERM`
 * before it is forcefully killed with `SIGKILL`. A process that ignores
 * `SIGTERM` (for example one blocked in an uninterruptible network call)
 * must not outlive the Action's own timeout, or it would keep burning
 * runner minutes until GitHub's much longer job timeout.
 */
export const SIGKILL_GRACE_MS = 5000;

/**
 * Runs a Canary binary with the given arguments, capturing stdout and
 * stderr separately, enforcing `timeoutMs`, and forwarding cancellation
 * signals to the child process so a cancelled workflow does not leave it
 * orphaned.
 *
 * Resolves with the process's own exit code/signal in all normal cases —
 * it never throws for a *non-zero* Canary exit code, since that is a
 * meaningful result the caller must interpret, not a failure of this
 * function. It throws only when the process could not be run at all, or
 * was killed for exceeding its timeout.
 *
 * Takes `args`, `timeoutMs`, and the `sigkillGraceMs` grace period
 * directly (rather than an `ActionInputs`) so it can be exercised in
 * tests without minute-granularity timeouts; `main.ts` is the only caller
 * that derives these from real inputs, and it relies on the default grace
 * period.
 */
export function runCheck(
  binaryPath: string,
  args: readonly string[],
  timeoutMs: number,
  sigkillGraceMs: number = SIGKILL_GRACE_MS,
): Promise<CheckExecutionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let sigkillHandle: NodeJS.Timeout | undefined;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      // Arm the escalation timer *before* signalling: if the process closes
      // synchronously in response to SIGTERM, `cleanup` must see the handle
      // so it can clear it, rather than leaving an orphaned timer that kills
      // (or worse, signals a reused pid) after the fact.
      sigkillHandle = setTimeout(() => {
        child.kill("SIGKILL");
      }, sigkillGraceMs);
      child.kill("SIGTERM");
    }, timeoutMs);
    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of SIGNALS_TO_FORWARD) {
      process.on(signal, forwardSignal);
    }

    const cleanup = (): void => {
      clearTimeout(timeoutHandle);
      if (sigkillHandle !== undefined) {
        clearTimeout(sigkillHandle);
      }
      for (const signal of SIGNALS_TO_FORWARD) {
        process.off(signal, forwardSignal);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CanaryExecutionFailedError(`Failed to start ${binaryPath}: ${error.message}`));
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (timedOut) {
        reject(
          new TimeoutError(
            `Stellar Protocol Canary timed out after ${String(Math.round(timeoutMs / 1000))}s and was terminated.`,
          ),
        );
        return;
      }

      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}
