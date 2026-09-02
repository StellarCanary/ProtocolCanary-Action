/**
 * Typed internal errors. Each one maps to a distinct, user-facing failure
 * category so that a compatibility failure (Canary ran and found a real
 * problem) is never confused with the Action failing to run Canary at all.
 */

export abstract class CanaryActionError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An Action input failed validation before Canary was ever invoked. */
export class InvalidInputError extends CanaryActionError {
  readonly code = "InvalidInput";
}

/** A `config` input was given but the file does not exist. */
export class ConfigNotFoundError extends CanaryActionError {
  readonly code = "ConfigNotFound";

  constructor(readonly path: string) {
    super(`Configuration file not found: ${path}`);
  }
}

/** No usable `stellar-canary` binary could be found or installed. */
export class CanaryNotFoundError extends CanaryActionError {
  readonly code = "CanaryNotFound";
}

/** Installing the requested Canary version failed. */
export class InstallationFailedError extends CanaryActionError {
  readonly code = "InstallationFailed";
}

/** The Canary process could not be started or was killed abnormally. */
export class CanaryExecutionFailedError extends CanaryActionError {
  readonly code = "CanaryExecutionFailed";
}

/** The Canary process exceeded its allotted execution time. */
export class TimeoutError extends CanaryActionError {
  readonly code = "Timeout";
}

/** Canary's stdout could not be parsed as a report matching the documented schema. */
export class InvalidReportError extends CanaryActionError {
  readonly code = "InvalidReport";
}

/** Uploading the JSON report as a workflow artifact failed. */
export class ArtifactUploadFailedError extends CanaryActionError {
  readonly code = "ArtifactUploadFailed";
}

/** Publishing the GitHub job summary failed. */
export class SummaryPublishFailedError extends CanaryActionError {
  readonly code = "SummaryPublishFailed";
}

export function isCanaryActionError(error: unknown): error is CanaryActionError {
  return error instanceof CanaryActionError;
}

/**
 * Formats an unknown thrown value into a safe, single-line message.
 * Never includes a stack trace: stack traces are only surfaced via
 * `core.debug`, gated on `ACTIONS_STEP_DEBUG`, by the caller.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
