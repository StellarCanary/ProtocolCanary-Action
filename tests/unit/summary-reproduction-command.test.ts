import { afterEach, describe, expect, it } from "vitest";

import {
  buildArtifactUrl,
  protocolMismatchMessage,
  renderExecutionFailureMarkdown,
  renderReproductionCommand,
  renderSummaryMarkdown,
} from "../../src/summary";
import { report, result } from "./helpers";

function extractCommandLine(markdown: string): string {
  const match = /^(`{3,})text\n([\s\S]*?)\n\1$/m.exec(markdown);
  if (!match || match[2] === undefined) {
    throw new Error(`Expected a fenced text block in markdown:\n${markdown}`);
  }
  return match[2].trim();
}

describe("renderReproductionCommand", () => {
  it("wraps the reproduction command in a clean collapsible details block", () => {
    const rendered = renderReproductionCommand(["check", "--protocol", "28", "--format", "json"]);

    expect(rendered.startsWith("<details><summary>Reproduction command</summary>\n\n")).toBe(true);
    expect(rendered.endsWith("\n\n</details>\n")).toBe(true);
    expect(rendered).not.toContain("Engine version:");
    expect(extractCommandLine(rendered)).toBe("stellar-canary check --protocol 28 --format json");
  });

  it("renders Engine version metadata and preserves --version CLI flags when provided", () => {
    const rendered = renderReproductionCommand(
      ["check", "--version", "0.3.1-rc.2", "--network=testnet", "--protocol", "28"],
      "0.3.1-rc.2",
    );

    expect(rendered).toContain("Engine version: `0.3.1-rc.2`");
    expect(extractCommandLine(rendered)).toBe(
      "stellar-canary check --version 0.3.1-rc.2 --network=testnet --protocol 28",
    );
  });

  it("escapes backticks inside engineVersion using a wider Markdown code span", () => {
    const rendered = renderReproductionCommand(["--version"], "0.3.1`dev");

    expect(rendered).toContain("Engine version: ``0.3.1`dev``");
    expect(extractCommandLine(rendered)).toBe("stellar-canary --version");
  });

  it("safely single-quotes arguments with whitespace, dollar signs, quotes, backslashes, and semicolons", () => {
    const rendered = renderReproductionCommand([
      "check",
      "--fixtures-dir",
      "path with spaces/canary fixtures",
      "--env-Probe",
      "$HOME/$(whoami)/${GITHUB_TOKEN}",
      "--double-quotes",
      'say "stellar"',
      "--single-quotes",
      "it's-a-'hostile'-arg",
      "--windows-path",
      "C:\\Users\\runner\\fixtures\\pack",
      "--injection",
      "testnet; rm -rf /; echo pwned",
    ]);

    const command = extractCommandLine(rendered);
    expect(command).toBe(
      [
        "stellar-canary",
        "check",
        "--fixtures-dir",
        "'path with spaces/canary fixtures'",
        "--env-Probe",
        "'$HOME/$(whoami)/${GITHUB_TOKEN}'",
        "--double-quotes",
        '\'say "stellar"\'',
        "--single-quotes",
        "'it'\\''s-a-'\\''hostile'\\''-arg'",
        "--windows-path",
        "'C:\\Users\\runner\\fixtures\\pack'",
        "--injection",
        "'testnet; rm -rf /; echo pwned'",
      ].join(" "),
    );
  });

  it("quotes pipes, background operators, globs, redirects, newlines, and non-option equals signs", () => {
    const rendered = renderReproductionCommand([
      "check",
      "FOO=bar",
      "=zsh_lookup",
      "a|b&&c||d",
      "*.xdr",
      "out>/tmp/pwn",
      "line1\nline2\ttab",
      "",
    ]);

    const command = extractCommandLine(rendered);
    expect(command).toBe(
      [
        "stellar-canary",
        "check",
        "'FOO=bar'",
        "'=zsh_lookup'",
        "'a|b&&c||d'",
        "'*.xdr'",
        "'out>/tmp/pwn'",
        "'line1\nline2\ttab'",
        "''",
      ].join(" "),
    );
  });

  it("expands the Markdown code fence when hostile CLI arguments contain triple backticks", () => {
    const hostileArg = "payload```with````backticks";
    const rendered = renderReproductionCommand(["check", "--filter", hostileArg]);

    const fenceMatch = /^(`{4,})text\n/m.exec(rendered);
    expect(fenceMatch).not.toBeNull();
    const fence = fenceMatch![1]!;
    expect(fence.length).toBeGreaterThan(4);
    expect(extractCommandLine(rendered)).toBe(`stellar-canary check --filter '${hostileArg}'`);
  });

  it("masks credentials and query parameters in --rpc-url and --rpc-url= forms and handles trailing --rpc-url", () => {
    const twoArg = renderReproductionCommand([
      "check",
      "--rpc-url",
      "https://user:supersecret@rpc.testnet.stellar.org:443/v1?api_key=tok_123#frag",
    ]);
    expect(extractCommandLine(twoArg)).toBe(
      "stellar-canary check --rpc-url 'https://[REDACTED]@rpc.testnet.stellar.org:443/v1[REDACTED]'",
    );
    expect(twoArg).not.toContain("supersecret");
    expect(twoArg).not.toContain("tok_123");
    expect(twoArg).not.toContain("frag");

    const inlineArg = renderReproductionCommand([
      "check",
      "--rpc-url=https://rpc.testnet.stellar.org/soroban?token=secret&mode=fast",
    ]);
    expect(extractCommandLine(inlineArg)).toBe(
      "stellar-canary check '--rpc-url=https://rpc.testnet.stellar.org/soroban[REDACTED]'",
    );
    expect(inlineArg).not.toContain("secret");

    const cleanRpc = renderReproductionCommand([
      "check",
      "--rpc-url",
      "https://soroban-testnet.stellar.org",
      "--rpc-url",
    ]);
    expect(extractCommandLine(cleanRpc)).toBe(
      "stellar-canary check --rpc-url https://soroban-testnet.stellar.org --rpc-url",
    );
  });
});

describe("protocolMismatchMessage", () => {
  it("formats expected target vs observed network protocol versions in both directions", () => {
    const behind = report({
      targetProtocol: 28,
      network: { name: "testnet", observedProtocol: 27 },
    });
    expect(protocolMismatchMessage(behind)).toBe(
      "Protocol mismatch: the network reported protocol 27, but this run targets protocol 28.",
    );

    const ahead = report({
      targetProtocol: 27,
      network: { name: "futurenet", observedProtocol: 29 },
    });
    expect(protocolMismatchMessage(ahead)).toBe(
      "Protocol mismatch: the network reported protocol 29, but this run targets protocol 27.",
    );
  });

  it("returns undefined when protocols match, network metadata is absent, or protocol numbers are invalid", () => {
    expect(
      protocolMismatchMessage(
        report({ targetProtocol: 28, network: { name: "testnet", observedProtocol: 28 } }),
      ),
    ).toBeUndefined();
    expect(protocolMismatchMessage(report({ targetProtocol: 28 }))).toBeUndefined();
    expect(
      protocolMismatchMessage(report({ targetProtocol: 28, network: { name: "testnet" } })),
    ).toBeUndefined();

    for (const invalid of [0, -5, 27.25, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        protocolMismatchMessage(
          report({ targetProtocol: 28, network: { name: "testnet", observedProtocol: invalid } }),
        ),
      ).toBeUndefined();
      expect(
        protocolMismatchMessage(
          report({ targetProtocol: invalid, network: { name: "testnet", observedProtocol: 28 } }),
        ),
      ).toBeUndefined();
    }
  });

  it("surfaces the protocol mismatch callout alongside collapsible reproduction and skipped sections in summary markdown", () => {
    const markdown = renderSummaryMarkdown(
      report({
        status: "fail",
        targetProtocol: 28,
        network: { name: "testnet", observedProtocol: 26 },
        counts: { total: 1, passed: 0, failed: 1, warnings: 0, errors: 0, skipped: 1 },
        results: [
          result({
            testId: "p28-rpc-ledger-001",
            surface: "rpc",
            status: "fail",
            summary: "RPC protocol version mismatch",
            details: "expected protocol 28 ledger header, got 26",
            fixtureId: "p28-rpc-ledger-001",
          }),
        ],
        skipped: [
          {
            fixtureId: "p28-soroban-cap-002",
            surface: "soroban",
            code: "UNSUPPORTED_PROTOCOL",
            reason: "network is on protocol 26",
          },
        ],
      }),
      {
        engineVersion: "0.2.4",
        engineArgs: ["check", "--protocol", "28", "--fixtures-dir", "pack dir;v28"],
      },
    );

    expect(markdown).toContain("Network: testnet — observed protocol 26");
    expect(markdown).toContain(
      "> ⚠️ Protocol mismatch: the network reported protocol 26, but this run targets protocol 28.",
    );
    expect(markdown).toContain("<details><summary>Reproduction command</summary>");
    expect(markdown).toContain("Engine version: `0.2.4`");
    expect(markdown).toContain("stellar-canary check --protocol 28 --fixtures-dir 'pack dir;v28'");
    expect(markdown).toContain("<details><summary>Skipped fixtures</summary>");
    expect(markdown).toContain("</details>");
  });
});

describe("renderExecutionFailureMarkdown", () => {
  const originalEnv = {
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("renders valid GFM failure headings, exit code reason, sanitized diagnostics, and artifact link", () => {
    process.env.GITHUB_SERVER_URL = "https://github.com/";
    process.env.GITHUB_REPOSITORY = "StellarCanary/ProtocolCanary-Action";
    process.env.GITHUB_RUN_ID = "987654321";

    const markdown = renderExecutionFailureMarkdown(
      "\x1b[31mEngine exited with code 2\x1b[0m",
      "\x1b[33merror:\x1b[0m invalid CLI flag --unknown\n::error::workflow injection attempt",
      { id: 42, name: "canary-failure-diagnostics" },
    );

    expect(markdown).toContain("## Stellar Protocol Canary");
    expect(markdown).toContain("### Result\n\n🚫 **ERROR**");
    expect(markdown).toContain("Protocol Canary could not be executed.");
    expect(markdown).toContain("Reason: Engine exited with code 2");
    expect(markdown).not.toContain("\x1b[");
    expect(markdown).toContain(
      `Report artifact: [canary-failure-diagnostics](${buildArtifactUrl(42)})`,
    );
    expect(markdown).toContain(
      "https://github.com/StellarCanary/ProtocolCanary-Action/actions/runs/987654321/artifacts/42",
    );

    const fenceMatch = /^(`{20,})text\n([\s\S]*?)\n\1$/m.exec(markdown);
    expect(fenceMatch).not.toBeNull();
    expect(fenceMatch![2]).toContain("error: invalid CLI flag --unknown");
    expect(fenceMatch![2]).not.toContain("\n::error::");
  });

  it("renders the placeholder notice on blank diagnostics and falls back to the default artifact name", () => {
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_RUN_ID;
    process.env.GITHUB_SERVER_URL = "https://ghe.example.org";

    const markdown = renderExecutionFailureMarkdown("Process exited with code 127", "   \n\t  ", {
      id: 77,
    });

    expect(markdown).toContain("Reason: Process exited with code 127");
    expect(markdown).toContain(
      "Report artifact: [stellar-protocol-canary-report](https://ghe.example.org/actions/runs/artifacts/77)",
    );
    expect(markdown).toContain(`${"`".repeat(20)}text\n(no diagnostic output)\n${"`".repeat(20)}`);
  });

  it("prevents embedded 22-backtick fences and reproduction snippets from breaking out of the diagnostic block", () => {
    const embeddedTicks = "`".repeat(22);
    const diagnostic = [
      "exit status 101: engine panic",
      `${embeddedTicks}text`,
      "nested reproduction snippet: stellar-canary check --fixtures-dir 'bad;path'",
      embeddedTicks,
    ].join("\n");

    const markdown = renderExecutionFailureMarkdown("Engine crashed (exit code 101)", diagnostic);
    const opening = /^(`{20,})text$/m.exec(markdown);
    expect(opening).not.toBeNull();
    const fence = opening![1]!;

    const lines = markdown.split("\n");
    expect(lines.filter((line) => line === `${fence}text`)).toHaveLength(1);
    expect(lines.filter((line) => line === fence)).toHaveLength(1);
    for (const line of lines) {
      const leadingTicks = /^`+/.exec(line)?.[0] ?? "";
      if (leadingTicks.length >= fence.length) {
        expect([fence, `${fence}text`]).toContain(line);
      }
    }
    expect(markdown).toContain("\\`".repeat(22) + "text");
    expect(markdown).toContain("nested reproduction snippet: stellar-canary check --fixtures-dir 'bad;path'");
  });
});
