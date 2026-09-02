import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConfigNotFoundError, InvalidInputError } from "./errors";

export interface ActionInputs {
  readonly protocol: number | undefined;
  readonly config: string | undefined;
  readonly network: string | undefined;
  readonly rpcUrl: string | undefined;
  readonly fixturesDir: string;
  readonly version: string;
  readonly uploadReport: boolean;
  readonly annotations: boolean;
  readonly timeoutMinutes: number;
}

const SEMVER_LIKE = /^\d+\.\d+\.\d+$/;
const PROTOCOL_LIKE = /^\d+$/;

/** Reads and validates every Action input. Throws {@link InvalidInputError} or
 * {@link ConfigNotFoundError} on the first problem found. */
export function getInputs(): ActionInputs {
  const protocol = parseProtocol(core.getInput("protocol"));
  const config = parseConfig(core.getInput("config"));
  const network = optional(core.getInput("network"));
  const rpcUrl = parseRpcUrl(core.getInput("rpc-url"));
  const fixturesDir = core.getInput("fixtures-dir") || "fixtures";
  const version = parseVersion(core.getInput("version") || "0.1.0");
  const uploadReport = parseBoolean("upload-report", core.getInput("upload-report") || "true");
  const annotations = parseBoolean("annotations", core.getInput("annotations") || "true");
  const timeoutMinutes = parseTimeout(core.getInput("timeout-minutes") || "15");

  return {
    protocol,
    config,
    network,
    rpcUrl,
    fixturesDir,
    version,
    uploadReport,
    annotations,
    timeoutMinutes,
  };
}

function optional(value: string): string | undefined {
  return value.trim() === "" ? undefined : value.trim();
}

function parseProtocol(raw: string): number | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  if (!PROTOCOL_LIKE.test(value)) {
    throw new InvalidInputError(
      `Invalid "protocol" input: ${JSON.stringify(value)}. Expected a non-negative integer, e.g. "28".`,
    );
  }
  return Number.parseInt(value, 10);
}

function parseConfig(raw: string): string | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    throw new ConfigNotFoundError(value);
  }
  return value;
}

function parseRpcUrl(raw: string): string | undefined {
  const value = optional(raw);
  if (value === undefined) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidInputError(`Invalid "rpc-url" input: ${JSON.stringify(value)}. Expected a valid URL.`);
  }

  const isLocalHttp =
    parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    throw new InvalidInputError(
      `Invalid "rpc-url" input: ${JSON.stringify(value)}. Must be an https:// URL ` +
        `(plain http:// is only accepted for localhost/127.0.0.1).`,
    );
  }

  return value;
}

function parseVersion(raw: string): string {
  const value = raw.trim().replace(/^v/i, "");
  if (!SEMVER_LIKE.test(value)) {
    throw new InvalidInputError(
      `Invalid "version" input: ${JSON.stringify(raw)}. Expected a semantic version, e.g. "0.1.0".`,
    );
  }
  return value;
}

const TRUE_VALUES = new Set(["true", "True", "TRUE"]);
const FALSE_VALUES = new Set(["false", "False", "FALSE"]);

function parseBoolean(name: string, raw: string): boolean {
  const value = raw.trim();
  if (TRUE_VALUES.has(value)) {
    return true;
  }
  if (FALSE_VALUES.has(value)) {
    return false;
  }
  throw new InvalidInputError(
    `Invalid "${name}" input: ${JSON.stringify(raw)}. Expected one of true/True/TRUE/false/False/FALSE.`,
  );
}

function parseTimeout(raw: string): number {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidInputError(
      `Invalid "timeout-minutes" input: ${JSON.stringify(raw)}. Expected a positive integer.`,
    );
  }
  return value;
}
