// Forbidden-pattern lib (C2 / F-5): pattern classes, case-insensitivity,
// URL-decoding, and the write-time redaction choke point. Pure fs/tmp — no
// AWS, no network.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FORBIDDEN, scanText, redactText, writeRedacted } from "../lib/redact.mjs";
import { buildResults, renderCheckSummary } from "../lib/report.mjs";

const hits = (text: string) => scanText(text).map((f) => f.why);

describe("scanText — new pattern classes (F-5)", () => {
  it("catches an AWS-secret-shaped 40-char mixed-case token", () => {
    expect(hits("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toContain(
      "AWS-secret-shaped token (40-char mixed-case base64)"
    );
  });

  it("does NOT flag a 40-char lowercase hex sha (no uppercase in the window)", () => {
    expect(hits('"source_commit": "c949b8b17624fd3e4f34a3cc8f62374dbb7f9fea"')).toEqual([]);
  });

  it("catches a JWT", () => {
    expect(hits("token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJiYXR0In0.sigDEFabc_-xyz")).toContain("JWT");
  });

  it("catches Slack tokens and Slack/Discord webhook URLs", () => {
    expect(hits("xoxb-1234-5678-abcdefgh")).toContain("Slack token");
    expect(hits("https://hooks.slack.com/services/T0/B0/x")).toContain("Slack webhook URL");
    expect(hits("https://discord.com/api/webhooks/1/x")).toContain("Discord webhook URL");
    expect(hits("https://discordapp.com/api/webhooks/1/x")).toContain("Discord webhook URL");
  });

  it("catches any non-allowlisted GitHub owner, case-insensitively", () => {
    expect(hits("see github.com/tycenjmccann/agentcore-hub")).toContain(
      "non-allowlisted GitHub owner (use example-org/sample-service)"
    );
    expect(hits("see github.com/TycenJMcCann/agentcore-hub")).toContain(
      "non-allowlisted GitHub owner (use example-org/sample-service)"
    );
    expect(hits("see github.com/evilcorp/thing")).toContain(
      "non-allowlisted GitHub owner (use example-org/sample-service)"
    );
    // Allowlist entries must match the FULL owner — 'examples' is not 'example'.
    expect(hits("see github.com/examples/thing")).toContain(
      "non-allowlisted GitHub owner (use example-org/sample-service)"
    );
  });

  it("does NOT flag allowlisted GitHub owners", () => {
    for (const url of [
      "github.com/example-org/sample-service",
      "github.com/example/repo",
      "github.com/actions/checkout",
      "github.com/github/docs",
    ]) {
      expect(hits(`see ${url}`)).toEqual([]);
    }
  });

  it("matches atlassian.net and TEAM-* case-insensitively", () => {
    expect(hits("host: AtLaSsIaN.NET")).toContain("real Jira host");
    expect(hits("ticket team-123")).toContain("real Jira project key (use BATT-*)");
    expect(hits("ticket Team-42")).toContain("real Jira project key (use BATT-*)");
  });

  it("catches URL-encoded bypasses on the ORIGINAL line number", () => {
    const text = "clean line\nanother clean line\nerr=%54EAM-3067 at atlassian%2Enet";
    const findings = scanText(text, { file: "x.json" });
    expect(findings.map((f) => f.why)).toEqual(
      expect.arrayContaining(["real Jira project key (use BATT-*)", "real Jira host"])
    );
    for (const f of findings) expect(f.line).toBe(3);
  });

  it("still passes every legacy pattern through (table superset)", () => {
    for (const probe of ["arn:aws:iam::x", "AKIAABCDEFGHIJKLMNOP", "-----BEGIN RSA", "x-api-key: z", "Bearer abc"]) {
      expect(hits(probe).length).toBeGreaterThan(0);
    }
  });
});

describe("redactText", () => {
  it("replaces every match with [REDACTED:<why>] and reports the count", () => {
    const { text, count, reasons } = redactText("ticket TEAM-3067 pushed to github.com/tycenjmccann/agentcore-hub");
    expect(count).toBe(2);
    expect(text).toContain("[REDACTED:real Jira project key (use BATT-*)]");
    expect(text).toContain("[REDACTED:non-allowlisted GitHub owner (use example-org/sample-service)]");
    expect(text).not.toMatch(/TEAM-[0-9]/);
    expect(text).not.toContain("tycenjmccann");
    expect(reasons).toContain("real Jira project key (use BATT-*)");
    // Reasons are descriptions only — the redacted text itself must be clean.
    expect(scanText(text)).toEqual([]);
  });

  it("drops a whole line whose URL-decoded copy matches (encoded bypass)", () => {
    const { text, count } = redactText("ok line\nerr=%54EAM-3067\nok line 2");
    expect(count).toBe(1);
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^\[REDACTED-LINE:.*url-encoded\)\]$/);
    expect(lines[0]).toBe("ok line");
    expect(lines[2]).toBe("ok line 2");
    expect(scanText(text)).toEqual([]);
  });

  it("returns clean text untouched with count 0", () => {
    const clean = "battery case BATT-1 passed on github.com/example-org/sample-service";
    expect(redactText(clean)).toEqual({ text: clean, count: 0, reasons: [] });
  });
});

describe("writeRedacted — the artifact write choke point", () => {
  it("writes redacted report output when a case error carries forbidden strings", () => {
    const poisonedError =
      "Bedrock judge crashed: Bearer abc123 rejected for TEAM-3067; " +
      "webhook https://hooks.slack.com/services/T0/B0/x, token xoxb-11-22-abc";
    const suite = {
      verdict: "FAIL",
      failureReasons: [`case 'batt-smoke' unscored: ${poisonedError}`],
      deltaRows: [],
      informationalCases: [],
      gatingCases: [],
      summary: { overallBaseline: null },
      bootstrapBaseline: false,
    };
    const results = buildResults({
      runId: "testrun",
      configSha: "c949b8b17624fd3e4f34a3cc8f62374dbb7f9fea",
      baselineSha: "c949b8b17624fd3e4f34a3cc8f62374dbb7f9fea",
      scoringBackend: "local-judge",
      suite,
      caseResults: [
        {
          id: "batt-smoke",
          status: "unscored",
          modelTier: "small",
          trajectory: [],
          scores: {},
          details: {},
          error: poisonedError,
        },
      ],
      retiredCases: [],
      costEstimateUsd: 0.1,
      runtimeSeconds: 1.2,
      configSources: null,
    });

    const dir = mkdtempSync(join(tmpdir(), "redact-test-"));
    try {
      const warnings: string[] = [];
      const warn = (msg: string) => warnings.push(msg);

      const resultsPath = join(dir, "battery-results.json");
      const summaryPath = join(dir, "check-summary.md");
      const r1 = writeRedacted(resultsPath, JSON.stringify(results, null, 2) + "\n", { warn });
      const r2 = writeRedacted(summaryPath, renderCheckSummary(results) + "\n", { warn });
      expect(r1.count).toBeGreaterThan(0);
      expect(r2.count).toBeGreaterThan(0);

      for (const p of [resultsPath, summaryPath]) {
        const written = readFileSync(p, "utf8");
        expect(written).toContain("[REDACTED:");
        expect(scanText(written)).toEqual([]);
        expect(written).not.toMatch(/TEAM-[0-9]|hooks\.slack\.com|xoxb-/);
      }
      // The warning names pattern reasons, never the matched text.
      expect(warnings.length).toBe(2);
      for (const w of warnings) {
        expect(w).toContain("redacted");
        expect(w).toContain("bearer token");
        expect(w).not.toMatch(/TEAM-3067|xoxb-11/);
      }
      // The redacted results JSON must stay parseable — the publish job reads it.
      expect(JSON.parse(readFileSync(resultsPath, "utf8")).verdict).toBe("FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes clean content byte-identical with no warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-test-"));
    try {
      const warnings: string[] = [];
      const p = join(dir, "out.json");
      const clean = '{"verdict":"PASS"}\n';
      const { count } = writeRedacted(p, clean, { warn: (m: string) => warnings.push(m) });
      expect(count).toBe(0);
      expect(warnings).toEqual([]);
      expect(readFileSync(p, "utf8")).toBe(clean);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FORBIDDEN table", () => {
  it("keeps every legacy pattern class", () => {
    const whys = FORBIDDEN.map(([, why]) => why);
    for (const legacy of [
      "real Jira project key (use BATT-*)",
      "real Jira host",
      "real artifact bucket name",
      "AWS ARN",
      "AWS-account-shaped id (12 consecutive digits)",
      "prod workflow-id shape (use wf_battery_*)",
      "AWS access key id",
      "PEM material",
      "API key header",
      "bearer token",
    ]) {
      expect(whys).toContain(legacy);
    }
  });
});
