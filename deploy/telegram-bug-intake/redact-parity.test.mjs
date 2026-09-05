import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// The ORIGINALS. The Telegram Lambda cannot import from lambda/orchestrator/ (it
// ships as its own zip), so redactText/clipText are hand-copied into it — the
// same situation as lease.ts ≡ lease.mjs, and the same remedy.
import { redactText as redactOrch, clipText as clipOrch } from "../../lambda/orchestrator/dead-session-escalation.mjs";

/**
 * TEAM-4120 FR-3 parity contract: the redaction the orchestrator applies when it
 * writes the page and the redaction the Telegram Lambda applies before the page
 * leaves the account MUST be the same function. A drift means one of two
 * failures, and both are silent:
 *   - Telegram redacts LESS than the hub → a secret reaches an off-account chat
 *     (the whole reason the copy exists is legacy rows, which arrive raw);
 *   - Telegram redacts MORE → the human reads a page of [REDACTED] and opens the
 *     UI anyway, which is the invisible-escalation bug FR-3 exists to fix.
 *
 * Two independent checks, because either alone can be fooled: the function
 * BODIES must be byte-equal, and a vector matrix must produce identical output
 * through both (which catches a divergence introduced by, say, a different `R`
 * constant or a helper redefined around the copy).
 */

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const ORCH_SRC = read("../../lambda/orchestrator/dead-session-escalation.mjs");
const TG_SRC = read("./index.mjs");

/** The function's source text from `function <name>(` to its column-0 close brace. */
function fnSource(src, name) {
  const m = new RegExp(`(?:export )?function ${name}\\(`).exec(src);
  expect(m, `${name} not found`).toBeTruthy();
  const start = m.index + (m[0].startsWith("export ") ? "export ".length : 0);
  const end = src.indexOf("\n}\n", start) + 3;
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("redactText / clipText: telegram-bug-intake ≡ dead-session-escalation.mjs", () => {
  for (const name of ["clipText", "redactText"]) {
    it(`${name} is a byte-identical copy`, () => {
      expect(fnSource(TG_SRC, name)).toBe(fnSource(ORCH_SRC, name));
    });
  }

  it("the Telegram copy is labelled as a copy, so the next editor sees this test", () => {
    expect(TG_SRC).toContain("byte-identical copy — parity test in deploy/telegram-bug-intake/redact-parity.test.mjs");
  });
});

/**
 * Evaluate the Telegram copies from source. Both are self-contained (no imports,
 * no module state) precisely so this is possible — and so the copy cannot
 * silently start depending on something only one side has.
 */
const tg = new Function(`${fnSource(TG_SRC, "clipText")}\n${fnSource(TG_SRC, "redactText")}\nreturn { clipText, redactText };`)();

const VECTORS = [
  "",
  "nothing secret here at all",
  `ghp_${"a".repeat(36)}`,
  `ghs_${"b".repeat(36)}`,
  `github_pat_${"c".repeat(24)}`,
  "AKIAIOSFODNN7EXAMPLE",
  "ASIAIOSFODNN7EXAMPLE",
  "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
  "https://bucket.s3.amazonaws.com/wf/x.json?X-Amz-Signature=abc123&X-Amz-Expires=900",
  "X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAX/20260901/us-east-1",
  "xoxb-123456789-abcdefXYZ",
  "hooks.slack.com/services/T00/B00/XXXX",
  "Bearer abc.def-ghi_jkl+mno/pqr=",
  "Authorization: Basic dXNlcjpwYXNz",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-DEF_123",
  `1234567890:${"A".repeat(35)}`,
  `sk-ant-api03-${"x".repeat(24)}`,
  `sk-${"y".repeat(32)}`,
  `ATATT${"z".repeat(30)}`,
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc/def+ghi=\n-----END RSA PRIVATE KEY-----",
  "api_key=abc123 password: hunter2 token=abc.def",
  "paged dev.ops+ci@example.co.uk about it",
  "[31mERROR[0m in ```js\nconst x = 1;\n``` `inline`   spaced\n\nlines",
  // Mixed, multi-line, and the clip-boundary case the ORDER contract exists for.
  `deploying with ghp_${"a".repeat(36)} to https://api.github.com/repos/o/r?token=abc\nthen paging ops@example.com`,
  `${"x".repeat(590)}ghp_${"a".repeat(36)}`,
  undefined,
  null,
  42,
];

describe("the same vectors through both copies", () => {
  it("redactText agrees on every vector", () => {
    for (const v of VECTORS) expect(tg.redactText(v), JSON.stringify(v)?.slice(0, 60)).toBe(redactOrch(v));
  });

  it("clipText agrees on every vector × budget", () => {
    for (const v of VECTORS) {
      for (const n of [0, 1, 5, 80, 240, 599, 600, 5000]) {
        expect(tg.clipText(v, n)).toBe(clipOrch(v, n));
      }
    }
  });

  it("and the composition the page actually uses (redact → clip 600 / 240)", () => {
    for (const v of VECTORS) {
      expect(tg.clipText(tg.redactText(v), 600)).toBe(clipOrch(redactOrch(v), 600));
      expect(tg.clipText(tg.redactText(v), 240)).toBe(clipOrch(redactOrch(v), 240));
    }
  });

  it("no vector leaks a recognizable secret prefix through either copy", () => {
    for (const v of VECTORS) {
      const out = tg.clipText(tg.redactText(v), 600);
      for (const marker of ["ghp_", "ghs_", "github_pat_", "AKIA", "ASIA", "xoxb-", "sk-ant-", "ATATT", "eyJ", "PRIVATE KEY"]) {
        expect(out, `${marker} survived ${JSON.stringify(v)?.slice(0, 40)}`).not.toContain(marker);
      }
    }
  });
});
