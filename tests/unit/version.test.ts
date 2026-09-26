import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:https", () => ({
  get: vi.fn(),
}));

import * as https from "node:https";
import { resolveVersion } from "../../src/version";

class FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  constructor(statusCode: number, headers: Record<string, string | string[] | undefined> = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
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

interface FakePage {
  statusCode?: number;
  body: string;
  /** Raw `Link` header value, when the page has a next page. */
  link?: string;
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

/**
 * Serves the given pages in order, recording every request's URL and headers.
 * The last page is reused for any extra requests so a bug that over-fetches
 * cannot hang the suite.
 */
function mockHttpsPages(pages: FakePage[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let index = 0;
  vi.mocked(https.get).mockImplementation((url, options, callback) => {
    const page = pages[Math.min(index, pages.length - 1)] ?? pages[0];
    if (page === undefined) {
      throw new Error("mockHttpsPages requires at least one page");
    }
    index += 1;
    const headers = ((options as { headers?: Record<string, string> } | undefined)?.headers ?? {}) as Record<
      string,
      string
    >;
    calls.push({ url: String(url), headers });
    const response = new FakeResponse(page.statusCode ?? 200, page.link !== undefined ? { link: page.link } : {});
    const request = new FakeRequest();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (callback as any)(response);
    queueMicrotask(() => {
      response.emit("data", page.body);
      response.emit("end");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return request as any;
  });
  return calls;
}

function tagsBody(entries: Array<{ name: string; sha: string }>): string {
  return JSON.stringify(entries.map((entry) => ({ name: entry.name, commit: { sha: entry.sha } })));
}

function nextLink(page: number): string {
  return `<https://api.github.com/repos/StellarCanary/Protocol-Canary/tags?per_page=100&page=${String(page)}>; rel="next"`;
}

const originalToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalToken;
  }
});

describe("resolveVersion", () => {
  it("resolves a matching tag to its commit sha", async () => {
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    const resolved = await resolveVersion("0.1.0");
    expect(resolved).toEqual({ version: "0.1.0", tag: "v0.1.0", commitSha: "abc123" });
    // A first-page match must not fetch a second page.
    expect(calls).toHaveLength(1);
  });

  it("degrades to commitSha undefined when the tag is not found", async () => {
    mockHttpsPages([{ body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]) }]);
    const resolved = await resolveVersion("0.1.0");
    expect(resolved.commitSha).toBeUndefined();
    expect(resolved.tag).toBe("v0.1.0");
  });

  it("degrades to commitSha undefined on a non-200 response, never throwing", async () => {
    mockHttpsPages([{ statusCode: 503, body: "" }]);
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
  });

  it("degrades to commitSha undefined on malformed JSON, never throwing", async () => {
    mockHttpsPages([{ body: "not json" }]);
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
  });

  it("sends an Authorization: Bearer header when an explicit token is supplied", async () => {
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    await resolveVersion("0.1.0", { token: "ghp_explicit" });
    expect(calls[0]?.headers.Authorization).toBe("Bearer ghp_explicit");
    // The unauthenticated User-Agent/Accept contract is unchanged.
    expect(calls[0]?.headers["User-Agent"]).toBe("ProtocolCanary-Action");
  });

  it("falls back to GITHUB_TOKEN from the environment when no explicit token is given", async () => {
    process.env.GITHUB_TOKEN = "ghp_from_env";
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    await resolveVersion("0.1.0");
    expect(calls[0]?.headers.Authorization).toBe("Bearer ghp_from_env");
  });

  it("sends no Authorization header when no token is available", async () => {
    delete process.env.GITHUB_TOKEN;
    const calls = mockHttpsPages([{ body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) }]);
    const resolved = await resolveVersion("0.1.0");
    expect(calls[0]?.headers.Authorization).toBeUndefined();
    // Preserves the existing unauthenticated first-page-match behavior.
    expect(resolved.commitSha).toBe("abc123");
  });

  it("paginates across pages, following Link rel=next, until the tag is found", async () => {
    const calls = mockHttpsPages([
      { body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]), link: nextLink(2) },
      { body: tagsBody([{ name: "v9.9.8", sha: "yyy" }]), link: nextLink(3) },
      { body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) },
    ]);
    const resolved = await resolveVersion("0.1.0");
    expect(resolved.commitSha).toBe("abc123");
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toContain("page=2");
    expect(calls[2]?.url).toContain("page=3");
  });

  it("keeps the Authorization header on every paginated request", async () => {
    process.env.GITHUB_TOKEN = "ghp_from_env";
    const calls = mockHttpsPages([
      { body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]), link: nextLink(2) },
      { body: tagsBody([{ name: "v0.1.0", sha: "abc123" }]) },
    ]);
    await resolveVersion("0.1.0");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.headers.Authorization === "Bearer ghp_from_env")).toBe(true);
  });

  it("degrades to commitSha undefined when every page is exhausted without a match", async () => {
    mockHttpsPages([
      { body: tagsBody([{ name: "v9.9.9", sha: "zzz" }]), link: nextLink(2) },
      { body: tagsBody([{ name: "v9.9.8", sha: "yyy" }]) },
    ]);
    await expect(resolveVersion("0.1.0")).resolves.toMatchObject({ commitSha: undefined });
  });
});
