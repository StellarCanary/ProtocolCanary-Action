import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { debugMock, warningMock } = vi.hoisted(() => ({
  debugMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  debug: debugMock,
  warning: warningMock,
}));

vi.mock("node:https", () => ({
  get: vi.fn(),
}));

import * as https from "node:https";
import { resolveVersion } from "../../src/version";

class FakeResponse extends EventEmitter {
  statusCode: number;
  constructor(statusCode: number) {
    super();
    this.statusCode = statusCode;
  }
  setEncoding(): void {
    /* no-op for this fake */
  }
  resume(): void {
    /* no-op for this fake */
  }
}

class FakeRequest extends EventEmitter {
  destroy(): void {
    /* no-op for this fake */
  }
}

function mockHttpsResponse(statusCode: number, body: string): void {
  vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
    const response = new FakeResponse(statusCode);
    const request = new FakeRequest();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (callback as any)(response);
    queueMicrotask(() => {
      response.emit("data", body);
      response.emit("end");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return request as any;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  debugMock.mockReset();
  warningMock.mockReset();
});

describe("resolveVersion", () => {
  it("resolves a matching tag to its commit sha", async () => {
    mockHttpsResponse(200, JSON.stringify([{ name: "v0.1.0", commit: { sha: "abc123" } }]));
    const resolved = await resolveVersion("0.1.0");
    expect(resolved).toEqual({ version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" });
  });

  it("warns and degrades to commitSha undefined when the tag is not found", async () => {
    mockHttpsResponse(200, JSON.stringify([{ name: "v9.9.9", commit: { sha: "zzz" } }]));
    const resolved = await resolveVersion("0.1.0");
    expect(resolved.commitSha).toBeUndefined();
    expect(resolved.tag).toBe("v0.1.0");
    expect(warningMock).toHaveBeenCalledWith(
      "Could not find tag v0.1.0; falling back to tag pinning with weaker integrity guarantees.",
    );
    expect(debugMock).not.toHaveBeenCalled();
  });

  it("degrades to commitSha undefined on a non-200 response, never throwing", async () => {
    mockHttpsResponse(503, "");
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
    expect(warningMock).not.toHaveBeenCalled();
    expect(debugMock).toHaveBeenCalled();
  });

  it("degrades to commitSha undefined on malformed JSON, never throwing", async () => {
    mockHttpsResponse(200, "not json");
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
  });
});
