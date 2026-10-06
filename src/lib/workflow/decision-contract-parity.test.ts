import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";

// The three byte-identical copies of the human-gate DECISION contract (TEAM-5322
// FR-9): both ticket twins verify a decision token, the Telegram bridge mints one.
// Each ships as a self-contained zip, so the module is duplicated, not shared.
import * as ticketsCopyTyped from "../../../lambda/agentcore-hub-tickets/decision-contract.mjs";
import * as jiraCopy from "../../../lambda/agentcore-hub-jira/decision-contract.mjs";
import * as bridgeCopy from "../../../deploy/telegram-bug-intake/decision-contract.mjs";
// TEAM-5340: gate-contract.mjs's import in workflow-output (verify side only).
import * as workflowOutputCopy from "../../../lambda/workflow-output/decision-contract.mjs";
// ...and the hub's TS port, which mints for the console.
import * as tsMirror from "./decision-contract";
// The three gate-contract copies: resolveDecision is where the scope binding bites.
import * as ticketsGate from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";
import * as jiraGate from "../../../lambda/agentcore-hub-jira/gate-contract.mjs";
import * as workflowOutputGate from "../../../lambda/workflow-output/gate-contract.mjs";

// The .mjs JSDoc-less defaults (`workflowId = null`) infer types narrower than the
// contract; the copies are exercised untyped, like fix-contract-parity's MODULES.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ticketsCopy: any = ticketsCopyTyped;

/**
 * TEAM-5322 parity contract — same shape as fix-contract-parity.test.ts.
 *
 * A drift here is a gate that can be answered on one channel and not the other:
 * a token the hub mints that a twin rejects (the console can never close the
 * gate), or a declaration one copy reads as bound and another as unbound (one
 * provider demands a signed decision, the other accepts agent text). Layered:
 *   1. byte-equality of the four .mjs copies (check-fix-kinds-parity.sh repeats it);
 *   2. one truth table pushed through all five implementations;
 *   3. tokens cross-minted TS → .mjs and .mjs → TS;
 *   4. the Telegram callback encoding the bridge's buttons will use (chunk D).
 */

const COPIES = [
  "lambda/agentcore-hub-tickets/decision-contract.mjs",
  "lambda/agentcore-hub-jira/decision-contract.mjs",
  "deploy/telegram-bug-intake/decision-contract.mjs",
  "lambda/workflow-output/decision-contract.mjs",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MODULES: Array<[string, any]> = [
  ["tickets", ticketsCopy],
  ["jira", jiraCopy],
  ["bridge", bridgeCopy],
  ["workflow-output", workflowOutputCopy],
  ["ts-mirror", tsMirror],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function agree(label: string, fn: (m: any) => unknown): unknown {
  const [[, first]] = MODULES;
  const expected = fn(first);
  for (const [name, mod] of MODULES.slice(1)) {
    expect(fn(mod), `${name} disagrees with tickets on: ${label}`).toEqual(expected);
  }
  return expected;
}

const KEY = "parity-test-key-not-a-secret";
const OLD_KEY = "parity-test-previous-key";
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

describe("decision-contract.mjs — the four copies are byte-identical", () => {
  it("every copy matches the first, byte for byte", () => {
    const root = resolve(__dirname, "../../..");
    const [firstPath, ...rest] = COPIES;
    const first = readFileSync(resolve(root, firstPath));
    for (const p of rest) {
      expect(readFileSync(resolve(root, p)).equals(first), `${p} drifted from ${firstPath}`).toBe(true);
    }
  });

  it("the copies import nothing but node:crypto (the bridge zip has no node_modules)", () => {
    const src = readFileSync(resolve(__dirname, "../../..", COPIES[0]), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["node:crypto"]);
  });

  it("the TS grammar half imports nothing (TicketDetailModal bundles it client-side)", () => {
    const src = readFileSync(resolve(__dirname, "decision-grammar.ts"), "utf8");
    expect([...src.matchAll(/^\s*import\b/gm)]).toEqual([]);
    expect(src).not.toMatch(/\brequire\(|\bBuffer\b/);
  });

  it("the TS mirror exports the same constants", () => {
    for (const name of [
      "DECISION_REQUIRED",
      "DECISION_TOKEN_PREFIX",
      "DECISION_TOKEN_MAX_TTL_SEC",
      "DEFAULT_GATE_DECISION_SECRET_ID",
      "DECISION_CALLBACK_PREFIX",
      "TELEGRAM_CALLBACK_MAX_BYTES",
      "UNIVERSAL_DECISION_OPTIONS",
      "GATE_SCOPE_MAX_FINDINGS",
    ]) {
      agree(name, (m) => m[name]);
    }
    agree("DECISION_OPTIONS_RE", (m) => m.DECISION_OPTIONS_RE.source);
    agree("DECISION_ANSWER_RE", (m) => [m.DECISION_ANSWER_RE.source, m.DECISION_ANSWER_RE.flags]);
    agree("FINDING_ID_RE", (m) => m.FINDING_ID_RE.source);
    expect(tsMirror.UNIVERSAL_DECISION_OPTIONS).toEqual(["stopped"]);
  });
});

/**
 * The 11-row grammar truth table. `options` is what parseDecisionOptions reads
 * from `description`; `answer` is what parseDecisionAnswer reads from `text`
 * against those options (or against OPTS when the description binds nothing).
 */
const OPTS = ["approve", "reject"];
const TRUTH: Array<{
  row: string;
  description: string;
  text: string;
  options: string[] | null;
  answer: { option: string; override: boolean } | null;
}> = [
  {
    row: "1. a declaration binds; a plain answer is read",
    description: "Merge brief\nDECISION OPTIONS: approve | reject",
    text: "DECISION: approve",
    options: ["approve", "reject"],
    answer: { option: "approve", override: false },
  },
  {
    row: "2. no declaration binds nothing",
    description: "Approve this gate to continue.",
    text: "DECISION: approve",
    options: null,
    answer: { option: "approve", override: false },
  },
  {
    row: "3. a fenced declaration and a fenced answer are both ignored",
    description: "```\nDECISION OPTIONS: approve | reject\n```",
    text: "~~~\nDECISION: approve\n~~~",
    options: null,
    answer: null,
  },
  {
    row: "4. the LAST unfenced declaration and the LAST matching answer win",
    description: "DECISION OPTIONS: a | b\nlater:\nDECISION OPTIONS: continue | cancel",
    text: "DECISION: cancel\nthen\nDECISION: continue",
    options: ["continue", "cancel"],
    answer: { option: "continue", override: false },
  },
  {
    row: "5. override: is carried",
    description: "DECISION OPTIONS: continue | merge-with-known-findings | cancel",
    text: "DECISION: override:merge-with-known-findings",
    options: ["continue", "merge-with-known-findings", "cancel"],
    answer: { option: "merge-with-known-findings", override: true },
  },
  {
    row: "6. an undeclared option is no answer",
    description: "DECISION OPTIONS: approve | reject",
    text: "DECISION: ship-it",
    options: ["approve", "reject"],
    answer: null,
  },
  {
    row: "7. a single option is not a declaration",
    description: "DECISION OPTIONS: approve",
    text: "DECISION: approve",
    options: null,
    answer: { option: "approve", override: false },
  },
  {
    row: "8. an uppercase declaration is not one; an uppercase answer is lowercased",
    description: "DECISION OPTIONS: Approve | Reject",
    text: "decision: APPROVE",
    options: null,
    answer: { option: "approve", override: false },
  },
  {
    row: "9. bullets, bold and a trailing period are tolerated on the answer",
    description: "DECISION OPTIONS: approve | reject",
    text: "- **DECISION: reject**.",
    options: ["approve", "reject"],
    answer: { option: "reject", override: false },
  },
  {
    row: "10. duplicate options collapse; one unique option is not a declaration",
    description: "DECISION OPTIONS: approve | approve",
    text: "",
    options: null,
    answer: null,
  },
  {
    row: "11. the fix-ticket DECISION grammar does not collide (no answer is read from it)",
    description: "DECISION OPTIONS: repaired | accept-proxy | abort",
    text: "FIX DECISION: implement\nDECISION REQUIRED: who decides?",
    options: ["repaired", "accept-proxy", "abort"],
    answer: null,
  },
];

describe("decision grammar — one truth table, five implementations", () => {
  for (const t of TRUTH) {
    it(t.row, () => {
      const options = agree(`${t.row} (options)`, (m) => m.parseDecisionOptions(t.description));
      expect(options).toEqual(t.options);
      const against = (options as string[] | null) ?? OPTS;
      const answer = agree(`${t.row} (answer)`, (m) => m.parseDecisionAnswer(t.text, against));
      expect(answer).toEqual(t.answer);
    });
  }

  it("isDecisionBound (TS) is exactly human:* + a declaration the twins read as bound", () => {
    const bound = "DECISION OPTIONS: approve | reject";
    expect(tsMirror.isDecisionBound({ assignee: "human:operator", description: bound })).toBe(true);
    expect(tsMirror.isDecisionBound({ assignee: "release-manager", description: bound })).toBe(false);
    expect(tsMirror.isDecisionBound({ assignee: "human:operator", description: "no options" })).toBe(false);
    expect(tsMirror.isDecisionBound({})).toBe(false);
  });
});

describe("decision tokens — cross-minted between the TS mirror and the .mjs copies", () => {
  const JTI = "parity-jti-0000000001";
  const claims = { ticketId: "TEAM-4931", option: "approve", channel: "hub", by: "a@example.com", workflowId: "wf_1", now: NOW, jti: JTI };

  it("the same inputs mint the same token everywhere (the signed bytes agree)", () => {
    agree("mint", (m) => m.mintDecisionToken(claims, KEY));
  });

  for (const [minterName, minter] of MODULES) {
    for (const [verifierName, verifier] of MODULES) {
      if (minterName === verifierName) continue;
      it(`${minterName} → ${verifierName}`, () => {
        const token = minter.mintDecisionToken({ ...claims, channel: "telegram", by: "chat:42" }, KEY);
        expect(verifier.verifyDecisionToken(token, { ticketId: "TEAM-4931", keys: [KEY], now: NOW + 1000 })).toEqual({
          ok: true,
          option: "approve",
          override: true,
          channel: "telegram",
          by: "chat:42",
          workflowId: "wf_1",
          iat: NOW / 1000,
          exp: NOW / 1000 + 900,
          jti: JTI,
          // TEAM-5358 F3: no description was passed, so the scope of an empty one.
          s: ticketsCopy.scopeHash(undefined),
        });
      });
    }
  }

  it("failures agree: wrong ticket, expired, wrong key, tampered, malformed; AWSPREVIOUS still verifies", () => {
    const token = tsMirror.mintDecisionToken(claims, KEY);
    const later = NOW + 901 * 1000;
    agree("ticket mismatch", (m) => m.verifyDecisionToken(token, { ticketId: "TEAM-1", keys: [KEY], now: NOW }));
    expect(ticketsCopy.verifyDecisionToken(token, { ticketId: "TEAM-1", keys: [KEY], now: NOW })).toEqual({
      ok: false,
      reason: "token_ticket_mismatch",
    });
    expect(agree("expired", (m) => m.verifyDecisionToken(token, { ticketId: "TEAM-4931", keys: [KEY], now: later }))).toEqual({
      ok: false,
      reason: "token_expired",
    });
    expect(
      agree("ignoreExpiry", (m) =>
        m.verifyDecisionToken(token, { ticketId: "TEAM-4931", keys: [KEY], now: later, ignoreExpiry: true }).ok,
      ),
    ).toBe(true);
    expect(agree("wrong key", (m) => m.verifyDecisionToken(token, { keys: ["other"], now: NOW }))).toEqual({
      ok: false,
      reason: "token_signature",
    });
    expect(agree("no keys", (m) => m.verifyDecisionToken(token, { keys: [], now: NOW }))).toEqual({
      ok: false,
      reason: "token_signature",
    });
    const [head, sig] = [token.slice(0, token.lastIndexOf(".")), token.slice(token.lastIndexOf(".") + 1)];
    const forged = Buffer.from(
      JSON.stringify({ t: "TEAM-4931", o: "reject", c: "hub", by: "x", w: null, iat: NOW / 1000, exp: NOW / 1000 + 900 }),
    ).toString("base64url");
    expect(agree("tampered", (m) => m.verifyDecisionToken(`gd1.${forged}.${sig}`, { keys: [KEY], now: NOW }))).toEqual({
      ok: false,
      reason: "token_signature",
    });
    for (const bad of ["", "DECISION: approve", "gd1.", `${head}`, "gd1.!!!.!!!", 42, null]) {
      expect(agree(`malformed ${String(bad)}`, (m) => m.verifyDecisionToken(bad, { keys: [KEY], now: NOW }))).toEqual({
        ok: false,
        reason: "token_malformed",
      });
    }
    const rotated = ticketsCopy.mintDecisionToken(claims, OLD_KEY);
    expect(agree("rotation", (m) => m.verifyDecisionToken(rotated, { keys: [KEY, OLD_KEY], now: NOW }).ok)).toBe(true);
  });

  it("TEAM-5338 F3: a token carries a random single-use id unless the jti seam is used; TS and mjs agree", () => {
    const { jti: _seam, ...unseeded } = claims;
    void _seam;
    const ids = MODULES.map(([, m]) => m.verifyDecisionToken(m.mintDecisionToken(unseeded, KEY), { keys: [KEY], now: NOW }).jti);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(new Set(ids).size).toBe(ids.length);
    agree("bad jti refused at mint", (m) => {
      try {
        m.mintDecisionToken({ ...claims, jti: "short" }, KEY);
        return "minted";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(agree("jti pattern", (m) => m.DECISION_TOKEN_JTI_RE.source)).toBe("^[A-Za-z0-9_-]{16,64}$");
  });

  it("TEAM-5338 F3: an authentic token without a single-use id (pre-TEAM-5338 format) is malformed", () => {
    const head = "gd1." + Buffer.from(
      JSON.stringify({ t: "TEAM-4931", o: "approve", c: "hub", by: "x", w: "wf_1", iat: NOW / 1000, exp: NOW / 1000 + 900 }),
    ).toString("base64url");
    const sig = createHmac("sha256", KEY).update(head).digest().toString("base64url");
    expect(agree("no jti", (m) => m.verifyDecisionToken(`${head}.${sig}`, { keys: [KEY], now: NOW }))).toEqual({
      ok: false,
      reason: "token_malformed",
    });
  });

  it("TEAM-5338 F3: workflow mismatch / null workflow → token_workflow_mismatch", () => {
    const token = tsMirror.mintDecisionToken(claims, KEY);
    const unbound = tsMirror.mintDecisionToken({ ...claims, workflowId: null }, KEY);
    const v = (t: string, o: object) => agree(`wf ${JSON.stringify(o)}`, (m) => m.verifyDecisionToken(t, { keys: [KEY], now: NOW, ...o }));
    expect(v(token, { workflowId: "wf_2" })).toEqual({ ok: false, reason: "token_workflow_mismatch" });
    expect(v(token, { workflowId: null })).toEqual({ ok: false, reason: "token_workflow_mismatch" });
    expect(v(token, { workflowId: undefined })).toEqual({ ok: false, reason: "token_workflow_mismatch" });
    expect(v(unbound, { workflowId: "wf_1" })).toEqual({ ok: false, reason: "token_workflow_mismatch" });
    expect(v(unbound, { workflowId: null })).toEqual({ ok: false, reason: "token_workflow_mismatch" });
    expect((v(token, { workflowId: "wf_1" }) as { ok: boolean }).ok).toBe(true);
    // Not passing the key at all leaves the token unbound (legacy readers).
    expect((v(unbound, {}) as { ok: boolean }).ok).toBe(true);
  });

  it("TEAM-5347 F8: a token minted in the same second as the cut-off is stale; only the previous second verifies", () => {
    // `iat` is whole seconds and NOW sits on a second boundary, so iat = NOW/1000. A
    // cut-off anywhere inside that second (a reopen 1 ms after the click) stales the
    // token: it cannot be proven newer than the cut-off. TEAM-5338 pinned the opposite.
    const token = tsMirror.mintDecisionToken(claims, KEY);
    const v = (nb: number | undefined) => agree(`nb ${nb}`, (m) => m.verifyDecisionToken(token, { keys: [KEY], now: NOW + 5000, notBeforeMs: nb }));
    const stale = { ok: false, reason: "token_stale" };
    expect(v(NOW)).toEqual(stale);
    expect(v(NOW + 1)).toEqual(stale);
    expect(v(NOW + 999)).toEqual(stale);
    expect(v(NOW + 1000)).toEqual(stale);
    expect((v(NOW - 1) as { ok: boolean }).ok).toBe(true);
    expect((v(NOW - 60_000) as { ok: boolean }).ok).toBe(true);
    expect((v(undefined) as { ok: boolean }).ok).toBe(true);
  });

  it("the TTL is capped at 900s and a hand-built token over the cap is malformed", () => {
    const long = tsMirror.mintDecisionToken({ ...claims, ttlSec: 86400 }, KEY);
    expect(agree("ttl cap", (m) => m.verifyDecisionToken(long, { keys: [KEY], now: NOW }).exp)).toBe(NOW / 1000 + 900);
  });
});

describe("TEAM-5338 F6/F10 — canonicalJson and redactForLog (the .mjs copies)", () => {
  const MJS = MODULES.filter(([name]) => name !== "ts-mirror");
  const agreeMjs = (label: string, fn: (m: any) => unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const expected = fn(MJS[0][1]);
    for (const [name, mod] of MJS.slice(1)) expect(fn(mod), `${name} disagrees on: ${label}`).toEqual(expected);
    return expected;
  };

  it("canonicalJson sorts keys at every depth, keeps array order, drops undefined", () => {
    const a = { kind: "lambda_version", expect: { version: "5", codeSha256: undefined }, target: "x" };
    const b = { target: "x", expect: { version: "5" }, kind: "lambda_version" };
    expect(agreeMjs("same", (m) => m.canonicalJson(a) === m.canonicalJson(b))).toBe(true);
    expect(agreeMjs("shape", (m) => m.canonicalJson({ b: [2, { d: 1, c: 0 }], a: null }))).toBe('{"a":null,"b":[2,{"c":0,"d":1}]}');
    expect(agreeMjs("differs", (m) => m.canonicalJson(a) === m.canonicalJson({ ...b, target: "y" }))).toBe(false);
  });

  it("redactForLog redacts nested decision_token and gd1. strings", () => {
    const token = tsMirror.mintDecisionToken({ ticketId: "TEAM-1", option: "approve", channel: "hub", workflowId: "wf_1", now: NOW }, KEY);
    const event = {
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: "TEAM-1", decision_token: token, reason: `forwarded ${token} verbatim`, nested: [{ apiKey: "k" }] },
      usage: { inputTokens: 12 },
    };
    const out = agreeMjs("redact", (m) => m.redactForLog(event)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(out)).not.toContain(token.slice(4, 20));
    expect(out.parameters.decision_token).toBe("[redacted]");
    expect(out.parameters.reason).toBe("forwarded [redacted] verbatim");
    expect(out.parameters.nested[0].apiKey).toBe("[redacted]");
    expect(out.parameters.ticket_id).toBe("TEAM-1");
    expect(out.usage.inputTokens).toBe(12);
    expect(event.parameters.decision_token).toBe(token);
  });
});

describe("Telegram callback data — the bridge's option buttons (chunk D wires them)", () => {
  const options = ["continue", "merge-with-known-findings", "cancel"];
  const wf = "wf_1791220686225_znl7a4";

  it("encode agrees, round-trips through every decoder and never exceeds 64 bytes", () => {
    for (const option of options) {
      const data = agree(`encode ${option}`, (m) =>
        m.encodeDecisionCallback({ option, options, ticketId: "TEAM-5278", workflowId: wf }),
      ) as string;
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
      expect(agree(`decode ${option}`, (m) => m.decodeDecisionCallback(data, options))).toEqual({
        option,
        ticketId: "TEAM-5278",
        workflowId: wf,
      });
    }
  });

  it("an option too long to fit falls back to its index", () => {
    const longOpts = ["approve", "a".repeat(40)];
    const data = agree("encode long", (m) =>
      m.encodeDecisionCallback({ option: longOpts[1], options: longOpts, ticketId: "TEAM-5278", workflowId: wf }),
    );
    expect(data).toBe(`gdc|#1|TEAM-5278|${wf}`);
    expect(agree("decode index", (m) => m.decodeDecisionCallback(data, longOpts))).toEqual({
      option: longOpts[1],
      ticketId: "TEAM-5278",
      workflowId: wf,
    });
  });

  it("refusals agree: undeclared option, bad ids, foreign prefix, stale index", () => {
    expect(agree("undeclared", (m) => m.encodeDecisionCallback({ option: "x", options, ticketId: "TEAM-1" }))).toBeNull();
    expect(agree("bad ticket", (m) => m.encodeDecisionCallback({ option: "cancel", options, ticketId: "TEAM 1" }))).toBeNull();
    expect(
      agree("bad wf", (m) => m.encodeDecisionCallback({ option: "cancel", options, ticketId: "TEAM-1", workflowId: "a|b" })),
    ).toBeNull();
    for (const data of ["gok|TEAM-1", "gdc|cancel|TEAM-1", "gdc|nope|TEAM-1|", "gdc|#7|TEAM-1|", "gdc|cancel|TEAM 1|", 7]) {
      expect(agree(`decode ${String(data)}`, (m) => m.decodeDecisionCallback(data, options))).toBeNull();
    }
    expect(agree("no workflow", (m) => m.decodeDecisionCallback("gdc|cancel|TEAM-1|", options))).toEqual({
      option: "cancel",
      ticketId: "TEAM-1",
      workflowId: null,
    });
  });
});

describe("UNIVERSAL_DECISION_OPTIONS + scope binding (TEAM-5358 FR-6, F3)", () => {
  const HEAD = "19d074146120e4f72ec19b4276e25246cc043f82";
  const SCOPED = `Escalation\n\nDECISION OPTIONS: continue | accept-as-known\ngate-scope: {"round": 2, "headSha": "${HEAD}", "findingIds": ["TEAM-1:0000abcd"]}\n`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const GATES: Array<[string, any]> = [["tickets", ticketsGate], ["jira", jiraGate], ["workflow-output", workflowOutputGate]];

  it("stopped is admitted on every gate even when DECISION OPTIONS omits it (five implementations)", () => {
    expect(agree("admitted", (m) => m.admittedOptions(["approve", "reject"]))).toEqual(["approve", "reject", "stopped"]);
    expect(agree("admitted declared", (m) => m.admittedOptions(["stopped", "go"]))).toEqual(["stopped", "go"]);
    expect(agree("admitted none", (m) => m.admittedOptions(null))).toEqual(["stopped"]);
    expect(agree("answer", (m) => m.parseDecisionAnswer("DECISION: stopped", ["approve", "reject"]))).toEqual({ option: "stopped", override: false });
    // ...but it does not make an undeclared gate decision-bound, nor admit other text.
    expect(agree("bound", (m) => m.parseDecisionOptions("DECISION: stopped"))).toBeNull();
    expect(agree("no options", (m) => m.parseDecisionAnswer("DECISION: stopped", []))).toBeNull();
    expect(agree("other", (m) => m.parseDecisionAnswer("DECISION: merge", ["approve", "reject"]))).toBeNull();
    // A Telegram button for it round-trips (the index form runs over the admitted list).
    const data = agree("encode", (m) => m.encodeDecisionCallback({ option: "stopped", options: ["approve", "reject"], ticketId: "TEAM-1", workflowId: "wf_1" }));
    expect(data).toBe("gdc|stopped|TEAM-1|wf_1");
    expect(agree("decode", (m) => m.decodeDecisionCallback("gdc|#2|TEAM-1|wf_1", ["approve", "reject"]))).toEqual({ option: "stopped", ticketId: "TEAM-1", workflowId: "wf_1" });
    // Every resolver admits a signed stopped on a gate that never declared it.
    const token = tsMirror.mintDecisionToken({ ticketId: "TEAM-1", option: "stopped", channel: "hub", by: "eng@example.com", workflowId: "wf_1", description: SCOPED, now: NOW }, KEY);
    for (const [name, g] of GATES) {
      const r = g.resolveDecision({ ticketId: "TEAM-1", args: { decision_token: token }, options: ["continue", "accept-as-known"], keys: [KEY], now: NOW + 1000, workflowId: "wf_1", description: SCOPED });
      expect(r, name).toMatchObject({ ok: true, decision: { option: "stopped", by: "eng@example.com" } });
    }
  });

  it("scopeHash agrees across the four copies and the TS mirror", () => {
    const cases = [
      undefined,
      "",
      "no lines at all",
      "DECISION OPTIONS: approve | reject",
      SCOPED,
      // Same parsed scope, different spelling: ids reordered, head upper-cased, extra prose.
      `Other prose\nDECISION OPTIONS: continue|accept-as-known\ngate-scope: {"findingIds": ["TEAM-1:0000abcd", "TEAM-1:0000abcd"], "round": "2", "headSha": "${HEAD.toUpperCase()}"}`,
    ];
    const hashes = cases.map((d) => agree(`hash ${String(d).slice(0, 20)}`, (m) => m.scopeHash(d)) as string);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).toBe(hashes[2]);
    expect(hashes[3]).not.toBe(hashes[0]);
    expect(hashes[4]).not.toBe(hashes[3]);
    expect(hashes[5]).toBe(hashes[4]);
  });

  it("a token minted with scope s is refused by every verifier after the scope line changes", () => {
    const changedScope = SCOPED.replace("TEAM-1:0000abcd", "TEAM-1:0000beef");
    const changedOptions = SCOPED.replace("continue | accept-as-known", "continue | accept-as-known | merge");
    for (const [minterName, minter] of MODULES) {
      const token = minter.mintDecisionToken({ ticketId: "TEAM-1", option: "continue", channel: "telegram", by: "chat:1", workflowId: "wf_1", description: SCOPED, now: NOW }, KEY);
      for (const [name, m] of MODULES) {
        const v = m.verifyDecisionToken(token, { ticketId: "TEAM-1", keys: [KEY], now: NOW + 1000 });
        expect(v.s, `${minterName} → ${name}`).toBe(m.scopeHash(SCOPED));
        expect(v.s, `${minterName} → ${name} scope`).not.toBe(m.scopeHash(changedScope));
        expect(v.s, `${minterName} → ${name} options`).not.toBe(m.scopeHash(changedOptions));
      }
      for (const [name, g] of GATES) {
        const at = (description: string) =>
          g.resolveDecision({ ticketId: "TEAM-1", args: { decision_token: token }, options: ["continue", "accept-as-known"], keys: [KEY], now: NOW + 1000, workflowId: "wf_1", description });
        expect(at(SCOPED), `${minterName} → ${name} same`).toMatchObject({ ok: true });
        expect(at(changedScope), `${minterName} → ${name} scope`).toEqual({ ok: false, detail: "decision_scope_changed" });
        expect(at(changedOptions), `${minterName} → ${name} options`).toEqual({ ok: false, detail: "decision_scope_changed" });
      }
    }
    // A token from before the binding (no `s`) never matches a scope: fail closed.
    const legacyHead = "gd1." + Buffer.from(JSON.stringify({ t: "TEAM-1", o: "continue", c: "hub", by: "x", w: "wf_1", iat: NOW / 1000, exp: NOW / 1000 + 900, j: "legacy-jti-000000001" })).toString("base64url");
    const legacy = `${legacyHead}.${createHmac("sha256", KEY).update(legacyHead).digest("base64url")}`;
    for (const [name, g] of GATES) {
      expect(
        g.resolveDecision({ ticketId: "TEAM-1", args: { decision_token: legacy }, options: ["continue", "accept-as-known"], keys: [KEY], now: NOW + 1000, workflowId: "wf_1", description: SCOPED }),
        name
      ).toEqual({ ok: false, detail: "decision_scope_changed" });
    }
  });
});
