/**
 * TEAM-4660 guardrail — the approval scans may not compose their own ping text.
 *
 * The bug was not one bad string: it was that every approval site formatted its
 * own message, so two of them drifted into rendering agent-written ticket prose
 * while a third (the CodePipeline deploy ping) stayed templated. A behavioural
 * test can only pin the cases it thinks of; this one pins the SHAPE of the code,
 * so the next ping added here cannot reintroduce the class of bug:
 *
 *  1. Each approval scan delivers through sendApprovalPing() and contains no
 *     bare tgSend( / execPing( of its own.
 *  2. Only buildApprovalMessage() may stamp a kicker, and sendApprovalPing
 *     refuses text that is not stamped — so "the text came from the builder" is
 *     true by construction, not by convention.
 *  3. The two escalation kickers stay OUT of the reply-to-ping vocabulary: a
 *     reply to a manager / dead-session page must never be filed as a rework
 *     note (gateFromReply keys on "REVIEW GATE" / "SHIP-REVIEW ESCALATION" /
 *     "Changes requested").
 *
 * Source-level precedent in this suite: redact-parity.test.mjs, which asserts
 * two function bodies are byte-equal.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../index.mjs"), "utf8");

// index.mjs resolves its config at import time; the builder itself does no I/O,
// so the module only needs to load (no AWS/Telegram call is made here).
const ENV = {
  TELEGRAM_BOT_TOKEN: "111111:test-bot-token", JIRA_SITE_URL: "example.atlassian.net",
  JIRA_EMAIL: "bot@example.com", JIRA_API_TOKEN: "t", JIRA_PROJECT_KEY: "TEST",
  GITHUB_TOKEN: "t", GITHUB_USER: "test-user", PENDING_TABLE: "test-pending-table",
  HUB_API_URL: "https://hub.example.invalid", ALLOWED_CHAT_IDS: "12345", AWS_REGION: "us-east-1",
};
beforeAll(() => { Object.assign(process.env, ENV); });
afterAll(() => { for (const k of Object.keys(ENV)) delete process.env[k]; });

/**
 * The body of a top-level function declaration, by brace matching from its
 * signature (so a nested function or an object literal cannot end it early).
 * The parameter list is skipped by paren matching first — several of these
 * functions take a destructured object, whose `{` is not the body's.
 */
function bodyOf(src, name) {
  const sig = new RegExp(`^(?:async )?function ${name}\\s*\\(`, "m");
  const m = src.match(sig);
  expect(m, `${name}() must exist in index.mjs`).toBeTruthy();
  let paren = 0;
  let open = -1;
  for (let i = m.index + m[0].length - 1; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")") {
      paren--;
      if (paren === 0) { open = src.indexOf("{", i); break; }
    }
  }
  expect(open, `${name}() must have a body`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

// Every function that decides what an approval/gate page says.
const APPROVAL_SITES = [
  "scanReviewGates",
  "repageIfWindowOpened",
  "scanManagerEscalations",
  "scanDeployApprovalsForTarget",
  "deadSessionPing",
];
// …of which these actually deliver.
const SENDERS = APPROVAL_SITES.filter((n) => n !== "deadSessionPing");

describe("approval pings can only be composed by the builder", () => {
  it("no approval site formats or sends its own text", () => {
    for (const name of APPROVAL_SITES) {
      const body = bodyOf(SRC, name);
      expect(body, `${name}() must not call tgSend directly — use sendApprovalPing`).not.toMatch(/\btgSend\s*\(/);
      expect(body, `${name}() must not call execPing directly — use buildApprovalMessage`).not.toMatch(/\bexecPing\s*\(/);
    }
  });

  it("every approval site that delivers, delivers through sendApprovalPing", () => {
    for (const name of SENDERS) {
      expect(bodyOf(SRC, name), `${name}() must deliver via sendApprovalPing`).toMatch(/\bsendApprovalPing\s*\(/);
    }
  });

  it("only the builder renders a ping, and the sender rejects anything unstamped", () => {
    // execPing is the renderer; exactly one caller is allowed — the builder.
    const callers = SRC.split("\n")
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /\bexecPing\s*\(/.test(l) && !/^function execPing/.test(l.trim()));
    expect(callers, "execPing must have exactly one call site (buildApprovalMessage)").toHaveLength(1);
    expect(bodyOf(SRC, "buildApprovalMessage")).toMatch(/\bexecPing\s*\(/);
    // The refusal is what makes the stamp meaningful.
    const sender = bodyOf(SRC, "sendApprovalPing");
    expect(sender).toMatch(/buildApprovalMessage\(/);
    expect(sender).toMatch(/APPROVAL_KICKER_RE\.test\(text\)/);
    expect(sender).toMatch(/throw new Error/);
  });

  it("a reply to a manager / dead-session page can never be read as a rework note", async () => {
    const mod = await import("../index.mjs");
    // gateFromReply's vocabulary (index.mjs) — a page carrying any of these plus
    // a 🎫 handle is treated as a gate whose reply is a rework note.
    const REPLY_ROUTED = ["REVIEW GATE", "SHIP-REVIEW ESCALATION", "Changes requested"];
    for (const kind of ["manager", "dead-session"]) {
      const text = mod._buildApprovalMessageForTests({ gateKind: kind, subject: "A run", summary: "It stalled." });
      expect(text).toMatch(mod.APPROVAL_KICKER_RE);
      for (const phrase of REPLY_ROUTED) {
        expect(text, `${kind} kicker must not contain "${phrase}"`).not.toContain(phrase);
      }
    }
    // …while a real review gate keeps the vocabulary the router needs.
    for (const kind of ["review", "plan", "deploy", "merge"]) {
      expect(mod._buildApprovalMessageForTests({ gateKind: kind, subject: "A run" })).toContain("REVIEW GATE");
    }
    expect(mod._buildApprovalMessageForTests({ gateKind: "escalation", subject: "A run" })).toContain("SHIP-REVIEW ESCALATION");
  });

  it("the cap sheds content, never the kicker, handle, attempt line or ask", async () => {
    const mod = await import("../index.mjs");
    const text = mod._buildApprovalMessageForTests({
      gateKind: "deploy",
      subject: "A".repeat(400),
      shipping: Array.from({ length: 8 }, (_, i) => `${"S".repeat(120)}${i}`),
      summary: "B".repeat(600),
      bullets: Array.from({ length: 6 }, () => "C".repeat(200)),
      attempt: 4,
      previousIssue: "the fix regressed the nav smoke",
      meta: ["🎫 [TEAM-4658](https://example.atlassian.net/browse/TEAM-4658)"],
      ask: "Approve to continue, or Request changes to send it back.",
    });

    expect(text.length).toBeLessThanOrEqual(mod.APPROVAL_TEXT_MAX);
    expect(text).toMatch(mod.APPROVAL_KICKER_RE);
    expect(text).toContain("🎫 [TEAM-4658]");
    expect(text).toMatch(/^Attempt 4 — previous issue: the fix regressed the nav smoke$/m);
    expect(text).toContain("Approve to continue, or Request changes to send it back.");
    expect(text).not.toContain("C".repeat(200));   // bullets shed first
  });
});
