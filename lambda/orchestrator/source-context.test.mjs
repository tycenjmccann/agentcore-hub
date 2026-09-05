/**
 * TEAM-4093 (ship-review F2) — the intake-source line the orchestrator's
 * agent-context builder emits under "## Input Sources".
 *
 * PR #371 (TEAM-4054) made SOURCE_VALIDATION_MODE=lenient the default: a source
 * that fails its reachability check no longer rejects the submit, it is accepted
 * and persisted with `verification.status="unverified"` plus an already-redacted
 * `detail` (for a cross-account s3:// source, that detail carries the
 * ACCESS_DENIED_HINT naming the bucket-policy grant the hub-account runtime
 * agents need). The context builder emitted only `- [<type>] <label || value>`,
 * so the intake agent began a PAID run believing every source was readable — and
 * never saw the hint.
 *
 * formatSourceLine is the whole of that rendering, exported from index.mjs so it
 * is pinnable without driving the handler. The AWS SDK seams are mocked to inert
 * clients purely so index.mjs's module-load client construction succeeds offline
 * (same shape as detector-mode-default.test.mjs); nothing here does I/O.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({ Items: [] }) }) },
  GetCommand: class { constructor(i) { this.input = i; } },
  PutCommand: class { constructor(i) { this.input = i; } },
  UpdateCommand: class { constructor(i) { this.input = i; } },
  QueryCommand: class { constructor(i) { this.input = i; } },
  ScanCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { return {}; } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class { async send() { return {}; } },
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

const { formatSourceLine } = await import("./index.mjs");

// The real lenient-mode detail for a cross-account s3:// source (already
// redacted upstream by intake.ts → redactUrl). Reproduced verbatim so a future
// edit that truncates or re-shapes the detail — and drops the grant hint the
// agent needs — fails here.
const S3_DENIED_DETAIL =
  "S3 object unreadable — HeadObject -> AccessDenied (403): s3://bucket/key — " +
  "validator role has no read access to this bucket; runtime agents in the hub " +
  "account will need a bucket policy grant, or upload the object to the hub " +
  "artifacts bucket instead";

describe("formatSourceLine", () => {
  it("verified → the plain line, unchanged (no verdict noise for the happy path)", () => {
    const line = formatSourceLine({
      type: "url",
      value: "https://example.com/prd",
      label: "PRD",
      verification: { status: "verified", method: "GET (Range 0-0)", checkedAt: "2026-09-05T00:00:00.000Z" },
    });

    expect(line).toBe("- [url] PRD");
  });

  it("NO verification field → the plain line (backward compatible with every pre-TEAM-4054 workflow row)", () => {
    const line = formatSourceLine({ type: "url", value: "https://example.com/old", label: "Legacy" });

    expect(line).toBe("- [url] Legacy");
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("UNVERIFIED");
  });

  it("unverified WITH detail → appends the redacted detail verbatim (the ACCESS_DENIED_HINT reaches the agent)", () => {
    const line = formatSourceLine({
      type: "s3",
      value: "s3://bucket/key",
      label: "contract.pdf",
      verification: {
        status: "unverified",
        method: "HeadObject",
        detail: S3_DENIED_DETAIL,
        checkedAt: "2026-09-05T00:00:00.000Z",
      },
    });

    expect(line).toBe(`- [s3] contract.pdf — UNVERIFIED at intake: ${S3_DENIED_DETAIL}`);
    // The grant hint is the actionable half — pin it explicitly.
    expect(line).toContain("bucket policy grant");
  });

  it("unverified with MISSING detail → generic fallback, never the string \"undefined\"", () => {
    const line = formatSourceLine({
      type: "s3",
      value: "s3://bucket/key",
      verification: { status: "unverified", method: "HeadObject" },
    });

    expect(line).toBe("- [s3] s3://bucket/key — UNVERIFIED at intake: reachability check failed");
    expect(line).not.toContain("undefined");
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["non-string (number)", 500],
    ["non-string (object)", { message: "denied" }],
    ["null", null],
  ])("unverified with a %s detail → the same generic fallback, no coercion leak", (_label, detail) => {
    const line = formatSourceLine({
      type: "url",
      value: "https://example.com/x",
      verification: { status: "unverified", detail },
    });

    expect(line).toBe("- [url] https://example.com/x — UNVERIFIED at intake: reachability check failed");
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("[object Object]");
  });

  it('skipped → appends "not network-validated" (validation was off/unavailable, not failed)', () => {
    const line = formatSourceLine({
      type: "url",
      value: "https://example.com/spec",
      label: "Spec",
      verification: { status: "skipped", method: "none", checkedAt: "2026-09-05T00:00:00.000Z" },
    });

    expect(line).toBe("- [url] Spec — not network-validated");
  });

  it("label falls back to value when absent — including alongside a verdict suffix", () => {
    expect(formatSourceLine({ type: "file", value: "specs/rfp.md" })).toBe("- [file] specs/rfp.md");
    expect(
      formatSourceLine({ type: "file", value: "specs/rfp.md", verification: { status: "skipped" } })
    ).toBe("- [file] specs/rfp.md — not network-validated");
    // An empty label is falsy → value, same as the original `label || value`.
    expect(formatSourceLine({ type: "file", value: "specs/rfp.md", label: "" })).toBe("- [file] specs/rfp.md");
  });

  it("a mixed list preserves order and formats each source independently", () => {
    const sources = [
      { type: "url", value: "https://example.com/prd", label: "PRD", verification: { status: "verified" } },
      { type: "s3", value: "s3://bucket/key", label: "contract.pdf", verification: { status: "unverified", detail: S3_DENIED_DETAIL } },
      { type: "url", value: "https://example.com/spec", label: "Spec", verification: { status: "skipped" } },
      { type: "url", value: "https://example.com/old", label: "Legacy" }, // pre-TEAM-4054 row
      { type: "s3", value: "s3://b/k2", verification: { status: "unverified" } }, // missing detail
    ];

    const lines = sources.map(formatSourceLine);

    expect(lines).toEqual([
      "- [url] PRD",
      `- [s3] contract.pdf — UNVERIFIED at intake: ${S3_DENIED_DETAIL}`,
      "- [url] Spec — not network-validated",
      "- [url] Legacy",
      "- [s3] s3://b/k2 — UNVERIFIED at intake: reachability check failed",
    ]);
    // The whole block the builder appends — order intact, one line per source.
    expect(lines.join("\n")).not.toContain("undefined");
  });

  it("an unrecognized status is treated as no verdict (forward compatible, never throws)", () => {
    const line = formatSourceLine({
      type: "url",
      value: "https://example.com/y",
      verification: { status: "something-new" },
    });

    expect(line).toBe("- [url] https://example.com/y");
  });

  it("a null/undefined source does not throw (the builder loop must never take down a dispatch)", () => {
    expect(() => formatSourceLine(undefined)).not.toThrow();
    expect(() => formatSourceLine(null)).not.toThrow();
  });
});
