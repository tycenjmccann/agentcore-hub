import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GATE_PERSONAS,
  VERDICTS,
  deriveVerdict,
  enrichCompleteDetail,
  evaluateGate,
  normalizeSha,
  normalizeVerdict,
  normalizeVerdictMode,
  resolveTestedHead,
  resolveVerdict,
} from "./verdict-contract.mjs";

/**
 * The verdict contract, pinned against REAL completion records (TEAM-4246 D1).
 *
 * A synthetic "VERDICT: PASS" string proves nothing here: the whole reason
 * wf_1788731227559_dowtdh shipped over three failing verdicts is that verdicts
 * only ever existed as prose, and prose written by four different personas over
 * two runs looks like this —
 *
 *   "VERDICT: CHANGES NEEDED (round 1)."
 *   "CI verdict: PASS (legacy self-run; PIPELINE_ENABLED absent) for branch …"
 *   "QA VERDICT: PASS on head 1e1591f1e182fa4e9c0e303602be1e37c0388d0a …"
 *   "**Verdict: PASS — ci_status: github-actions-proxy** (NOT certified)"
 *   "**Ship review round 2 — PASS on head `7c2391ba…`**"
 *   "CD for TEAM-4116 — PR #395 MERGED and DEPLOYED … Verdict: code deploy SUCCEEDED"
 *
 * So the table below is generated from the two vendored dossiers, not typed out:
 * every completion record in both runs goes through resolveVerdict, and the
 * expectations are stated per ticket id. If a future ladder change reads the last
 * line as a PASS, or stops reading the round heading, this file fails with the
 * offending real summary in the diff.
 */

const dossier = (name) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../deploy/workflow-manager/toolkit/fixtures/${name}-dossier.json`, import.meta.url)), "utf8"),
  );

const DOSSIERS = { dowtdh: dossier("dowtdh"), f50ucz: dossier("f50ucz") };

/**
 * The real record + the real assignee, exactly as the orchestrator sees them.
 * Throws rather than asserting, so it is safe to call at describe scope too.
 */
const completionOf = (run, ticketId) => {
  const d = DOSSIERS[run];
  const record = d.completions[ticketId];
  const ticket = d.tickets.find((t) => t.ticketId === ticketId);
  if (!record || !ticket) throw new Error(`fixture ${run} has no completion + ticket pair for ${ticketId}`);
  return { record, assignee: ticket.assignee };
};

// [run, ticketId, expected verdict, expected verdictSource, expected testedHead prefix]
//
// Only gate personas appear with a verdict. The `null / null` rows are the
// counter-examples that keep GATE_PERSONAS honest: TEAM-4119's security review
// says "VERDICT: FAIL (narrow) … No fix tickets filed (per blueprint)" and MUST
// stay outside the gate, or every design cascade wedges on a reviewer that is
// allowed to fail without filing anything.
const TABLE = [
  // dowtdh — the run this ticket exists because of. Three failing/misaligned
  // gate verdicts in a row, every one of them prose-only.
  ["dowtdh", "TEAM-4180", "CHANGES_NEEDED", "inferred", "933ea6f"],   // code_reviewer
  ["dowtdh", "TEAM-4181", "FAIL", "inferred", "12e9ac6"],             // qa_verifier
  ["dowtdh", "TEAM-4182", "PASS", "inferred", "12e9ac6"],             // ci_agent — "CI verdict: PASS"
  ["dowtdh", "TEAM-4179", null, null, "1dab069"],                     // frontend_dev — not a gate
  ["dowtdh", "TEAM-4183", null, null, "001259d"],                     // the fix ticket itself
  // f50ucz — five more spellings, plus the two hardest negatives.
  ["f50ucz", "TEAM-4123", "CHANGES_NEEDED", "inferred", "6282d52"],   // code_reviewer
  ["f50ucz", "TEAM-4124", "PASS", "inferred", "1e1591f"],             // "QA VERDICT: PASS on head …"
  ["f50ucz", "TEAM-4125", "PASS", "inferred", "df1ed19"],             // "**Verdict: PASS — ci_status: …**"
  ["f50ucz", "TEAM-4126", "PASS", "inferred", "7c2391b"],             // round heading only, no "verdict:"
  ["f50ucz", "TEAM-4157", "PASS", "inferred", "7c2391b"],             // the re-cert after 4155/4156
  ["f50ucz", "TEAM-4128", null, "none", "ff64a7d"],                   // release_manager, "Verdict: code deploy SUCCEEDED"
  ["f50ucz", "TEAM-4119", null, null, null],                          // security_reviewer FAIL — deliberately not a gate
];

describe("verdict-contract — the real fixture summaries", () => {
  it.each(TABLE)("%s %s → %s (%s)", (run, ticketId, verdict, verdictSource, headPrefix) => {
    const { record, assignee } = completionOf(run, ticketId);
    expect(resolveVerdict(record, assignee)).toMatchObject({ verdict, verdictSource });
    const head = resolveTestedHead(record);
    if (headPrefix === null) expect(head).toBeNull();
    else expect(head.startsWith(headPrefix)).toBe(true);
  });

  it("covers every gate-persona completion in both dossiers — no silent gaps", () => {
    // Guards the table itself: add a gate completion to a fixture and this fails
    // until the table states what its verdict is.
    const gateIds = [];
    for (const [run, d] of Object.entries(DOSSIERS)) {
      for (const ticketId of Object.keys(d.completions)) {
        const ticket = d.tickets.find((t) => t.ticketId === ticketId);
        if (GATE_PERSONAS.has(ticket?.assignee)) gateIds.push(`${run}/${ticketId}`);
      }
    }
    const tabled = TABLE.filter(([, , , source]) => source !== null).map(([run, id]) => `${run}/${id}`);
    expect(gateIds.sort()).toEqual(tabled.sort());
  });

  it("no gate completion resolves to a verdict outside the enum", () => {
    for (const [run, d] of Object.entries(DOSSIERS)) {
      for (const [ticketId, record] of Object.entries(d.completions)) {
        const { verdict } = resolveVerdict(record, d.tickets.find((t) => t.ticketId === ticketId)?.assignee);
        if (verdict !== null) expect(VERDICTS, `${run}/${ticketId}`).toContain(verdict);
      }
    }
  });
});

describe("verdict-contract — null is not PASS", () => {
  // The load-bearing distinction. "The agent stated nothing I can read" must
  // never become "the agent passed", in either direction: a null verdict leaves
  // today's cascade behaviour exactly as it is, while a null read as PASS would
  // launder an unreadable summary into a green gate.
  it("an unreadable summary from a gate persona is `none`, never PASS", () => {
    const { record, assignee } = completionOf("f50ucz", "TEAM-4128");
    const resolved = resolveVerdict(record, assignee);
    expect(resolved.verdict).toBeNull();
    expect(resolved.verdictSource).toBe("none");
    expect(resolved.verdict).not.toBe("PASS");
  });

  it("`none` does not suppress the cascade under enforce", () => {
    // The other half of the same rule: a null verdict is not a failure either.
    // Holding every successor whose gate wrote an unreadable summary would stall
    // more runs than the hole D1 closes.
    const gate = evaluateGate({ assignee: "agentcore_hub_qa_verifier", verdict: null, spawnedTickets: [], mode: "enforce" });
    expect(gate).toMatchObject({ reason: "no-verdict", wouldSuppress: false, suppress: false, needsGateReverify: false });
  });

  it("prose about someone else's PASS is not this ticket's verdict", () => {
    // dowtdh TEAM-4183 (the fix) closes with "PR #46 merged" and no verdict; it
    // is also not a gate persona. Both reasons must independently give null.
    const { record, assignee } = completionOf("dowtdh", "TEAM-4183");
    expect(deriveVerdict(record.summary)).toBeNull();
    expect(resolveVerdict(record, assignee)).toEqual({ verdict: null, verdictSource: null });
  });
});

describe("verdict-contract — declared beats inferred", () => {
  const { record, assignee } = completionOf("dowtdh", "TEAM-4181");

  it("a declared verdict wins over the prose ladder, even in contradiction", () => {
    // The real TEAM-4181 summary says "VERDICT: FAIL". If the agent ALSO passed
    // verdict="PASS" on report_completion, the field wins: it is the value the
    // agent chose to put in a field, and summaries routinely quote other
    // tickets' verdicts.
    expect(resolveVerdict({ ...record, verdict: "PASS" }, assignee)).toEqual({ verdict: "PASS", verdictSource: "declared" });
  });

  it("falls back to the ladder when the declared value is absent or unusable", () => {
    for (const bad of [undefined, null, "", "   ", "SUCCEEDED", "probably fine", 7, {}]) {
      expect(resolveVerdict({ ...record, verdict: bad }, assignee)).toMatchObject({ verdict: "FAIL", verdictSource: "inferred" });
    }
  });

  it("reports the matched substring so an operator can see why", () => {
    expect(resolveVerdict(record, assignee).matched).toMatch(/VERDICT:\s*FAIL/i);
  });

  it("non-gate personas get null/null even with a declared verdict", () => {
    // The field is meaningless outside the gate set; storing it is fine, acting
    // on it is not.
    expect(resolveVerdict({ verdict: "FAIL" }, "agentcore_hub_backend_dev")).toEqual({ verdict: null, verdictSource: null });
    expect(resolveVerdict({ verdict: "FAIL" }, "agentcore_hub_security_reviewer")).toEqual({ verdict: null, verdictSource: null });
    expect(resolveVerdict({ verdict: "FAIL" }, undefined)).toEqual({ verdict: null, verdictSource: null });
  });
});

describe("verdict-contract — all three CHANGES_NEEDED spellings", () => {
  // Three spellings exist in this repo simultaneously and all three must read:
  //   "CHANGES NEEDED"  the blueprints' prose (dowtdh TEAM-4180, f50ucz TEAM-4123)
  //   "CHANGES-NEEDED"  PERSISTED in reviewGateHistory[].rounds[].verdict, compared
  //                     literally by ship-review.mjs and cost-report — never rename
  //   "CHANGES_NEEDED"  the new wire value
  it.each(["CHANGES NEEDED", "CHANGES-NEEDED", "CHANGES_NEEDED", "changes needed", "  Changes-Needed  ", "changes   needed"])(
    "%j → CHANGES_NEEDED",
    (raw) => expect(normalizeVerdict(raw)).toBe("CHANGES_NEEDED"),
  );

  it.each([
    ["VERDICT: CHANGES NEEDED (round 1).", "CHANGES_NEEDED"],
    ["Verdict: changes-needed", "CHANGES_NEEDED"],
    ["**VERDICT: CHANGES_NEEDED** — 8 blocking findings", "CHANGES_NEEDED"],
  ])("the ladder reads %j", (summary, expected) => expect(deriveVerdict(summary)?.verdict).toBe(expected));

  it("maps PASS-with-known-findings to PASS (review-cap's own spelling)", () => {
    expect(normalizeVerdict("PASS-with-known-findings")).toBe("PASS");
    expect(normalizeVerdict("pass")).toBe("PASS");
  });

  it("accepts FAIL and BLOCKED, and rejects everything else", () => {
    expect(normalizeVerdict("fail")).toBe("FAIL");
    expect(normalizeVerdict(" Blocked ")).toBe("BLOCKED");
    for (const bad of ["SUCCEEDED", "OK", "green", "NEEDS CHANGES", "FAILED", "", null, undefined, 1, ["PASS"]]) {
      expect(normalizeVerdict(bad), String(bad)).toBeNull();
    }
  });

  it("does not read a bare verdict word out of surrounding prose", () => {
    // Real summary fragments. A third ladder rung matching a lone PASS/FAIL
    // would turn every one of these into a gate decision.
    for (const summary of [
      "npm test 57/57 pass, tsc clean, GH Actions green.",
      "Deploy stage ended with the intentional HANDOFF exit 2 (no CD registry entry).",
      "0 Critical, 1 High (blocking), 7 Medium — see findings.md.",
      "The expired-token repro now fails closed instead of failing open.",
    ]) {
      expect(deriveVerdict(summary), summary).toBeNull();
    }
  });
});

describe("verdict-contract — a SHA is never scraped from prose", () => {
  it("reads the FIELD, not the five SHAs in TEAM-4180's summary", () => {
    // The summary mentions 351d5ec first (the PR #45 merge it reviewed against);
    // the head it actually reviewed is commit_sha 933ea6f. Any prose scan gets
    // this backwards, and a head gate that compares the wrong head passes.
    const { record } = completionOf("dowtdh", "TEAM-4180");
    expect(record.summary).toMatch(/351d5ec/);
    expect(resolveTestedHead(record).startsWith("933ea6f")).toBe(true);
  });

  it("ignores a hex-looking token that is not a commit at all", () => {
    // f50ucz TEAM-4128's prose contains a Telegram chat id; /[0-9a-f]{7,}/ reads
    // it as an object name.
    const { record } = completionOf("f50ucz", "TEAM-4128");
    expect(resolveTestedHead(record).startsWith("ff64a7d")).toBe(true);
  });

  it("returns null when no structured field carries a head, however rich the prose", () => {
    expect(resolveTestedHead({ summary: "Verified at head deadbeefcafe1234567 on the shared branch." })).toBeNull();
    const { record } = completionOf("f50ucz", "TEAM-4119");
    expect(resolveTestedHead(record)).toBeNull();
  });

  it("precedence: tested_head → ci_head_sha → commit_sha, snake or camel", () => {
    const all = { tested_head: "aaaaaaa", ci_head_sha: "bbbbbbb", commit_sha: "ccccccc", summary: "x" };
    expect(resolveTestedHead(all)).toBe("aaaaaaa");
    expect(resolveTestedHead({ ...all, tested_head: undefined })).toBe("bbbbbbb");
    expect(resolveTestedHead({ ...all, tested_head: "", ci_head_sha: "  " })).toBe("ccccccc");
    // agentTasks entries are camelCase; the S3 record is snake_case. Both are
    // passed to this function, so both spellings resolve.
    expect(resolveTestedHead({ testedHead: "ddddddd" })).toBe("ddddddd");
    expect(resolveTestedHead({ ciHeadSha: "eeeeeee" })).toBe("eeeeeee");
    expect(resolveTestedHead({ commitSha: "fffffff" })).toBe("fffffff");
  });

  it("a non-SHA in a SHA field is dropped, not passed through", () => {
    expect(resolveTestedHead({ tested_head: "HEAD", commit_sha: "933ea6f1f0" })).toBe("933ea6f1f0");
    for (const bad of ["", "   ", "abc", "main", "zzzzzzz", "0".repeat(41), "not-a-sha", 42, null, {}]) {
      expect(normalizeSha(bad), String(bad)).toBeNull();
    }
    expect(normalizeSha(" 933EA6F1F0 ")).toBe("933ea6f1f0");
    expect(resolveTestedHead(null)).toBeNull();
    expect(resolveTestedHead("933ea6f")).toBeNull();
  });
});

describe("verdict-contract — normalizeVerdictMode", () => {
  // Unset → shadow is unique to D1's three flags: every other flag in index.mjs
  // defaults off. Garbage → off (not shadow) because a typo is an operator who
  // meant something specific, and the safe reading of an unknown ask is to act
  // on nothing.
  it("unset or blank is shadow", () => {
    for (const raw of [undefined, null, "", "   "]) expect(normalizeVerdictMode(raw)).toBe("shadow");
  });

  it("the three modes round-trip, case- and space-insensitively", () => {
    expect(normalizeVerdictMode("off")).toBe("off");
    expect(normalizeVerdictMode(" SHADOW ")).toBe("shadow");
    expect(normalizeVerdictMode("Enforce")).toBe("enforce");
  });

  it("anything unrecognized is off", () => {
    for (const raw of ["enforce!", "on", "true", "1", "shadowed", "enfroce", 0, {}]) {
      expect(normalizeVerdictMode(raw), String(raw)).toBe("off");
    }
  });
});

describe("verdict-contract — evaluateGate", () => {
  const gateArgs = { assignee: "agentcore_hub_code_reviewer", verdict: "CHANGES NEEDED", spawnedTickets: ["TEAM-4183"] };

  it("off decides nothing at all", () => {
    expect(evaluateGate({ ...gateArgs, mode: "off" })).toEqual({
      reason: "off", wouldSuppress: false, suppress: false, blockOn: [], needsGateReverify: false,
    });
    // Garbage mode resolves to off, so it also decides nothing.
    expect(evaluateGate({ ...gateArgs, mode: "enfroce" }).suppress).toBe(false);
  });

  it("shadow computes the decision but does not act on it", () => {
    expect(evaluateGate({ ...gateArgs, mode: "shadow" })).toEqual({
      reason: "non-pass", wouldSuppress: true, suppress: false, blockOn: ["TEAM-4183"], needsGateReverify: false,
    });
  });

  it("enforce suppresses and holds on the fix ticket", () => {
    expect(evaluateGate({ ...gateArgs, mode: "enforce" })).toEqual({
      reason: "non-pass", wouldSuppress: true, suppress: true, blockOn: ["TEAM-4183"], needsGateReverify: false,
    });
  });

  it("a non-PASS with no fix ticket still suppresses, and asks for a gate re-verify", () => {
    // No fail-open: a non-PASS verdict must never unblock the successor. With
    // nothing to wait for, the caller files one re-verify and holds on that.
    for (const spawnedTickets of [[], undefined, [""], ["  "]]) {
      expect(evaluateGate({ ...gateArgs, spawnedTickets, mode: "enforce" })).toEqual({
        reason: "non-pass", wouldSuppress: true, suppress: true, blockOn: [], needsGateReverify: true,
      });
    }
  });

  it("trims and de-duplicates blockOn", () => {
    expect(evaluateGate({ ...gateArgs, spawnedTickets: [" TEAM-4183 ", "TEAM-4183", "TEAM-4184", 7, null], mode: "enforce" }).blockOn)
      .toEqual(["TEAM-4183", "TEAM-4184"]);
  });

  it("PASS and non-gate personas never suppress", () => {
    expect(evaluateGate({ ...gateArgs, verdict: "PASS", mode: "enforce" })).toMatchObject({ reason: "pass", suppress: false });
    expect(evaluateGate({ ...gateArgs, verdict: "PASS-with-known-findings", mode: "enforce" })).toMatchObject({ reason: "pass", suppress: false });
    for (const assignee of ["agentcore_hub_backend_dev", "agentcore_hub_security_reviewer", "agentcore_hub_requirements_analyst", undefined]) {
      expect(evaluateGate({ ...gateArgs, assignee, mode: "enforce" }), String(assignee)).toMatchObject({ reason: "not-a-gate", suppress: false });
    }
  });

  it("every gate persona in the set is gated, and FAIL/BLOCKED gate too", () => {
    for (const assignee of GATE_PERSONAS) {
      for (const verdict of ["FAIL", "BLOCKED", "CHANGES_NEEDED"]) {
        expect(evaluateGate({ assignee, verdict, spawnedTickets: ["TEAM-1"], mode: "enforce" }).suppress, `${assignee} ${verdict}`).toBe(true);
      }
    }
    expect(evaluateGate({ mode: "enforce" })).toMatchObject({ reason: "not-a-gate" });
  });

  it("gates exactly the four personas — not security_reviewer, not the devs", () => {
    expect([...GATE_PERSONAS].sort()).toEqual([
      "agentcore_hub_ci_agent",
      "agentcore_hub_code_reviewer",
      "agentcore_hub_qa_verifier",
      "agentcore_hub_release_manager",
    ]);
  });
});

describe("verdict-contract — enrichCompleteDetail", () => {
  const base = { ticketId: "TEAM-4181", agentId: "agentcore_hub_qa_verifier", workflowId: "wf_1" };
  const KEYS = ["verdict", "verdictSource", "testedHead", "wouldSuppress"];

  it("always emits all four keys, with off-defaults, when nothing is known", () => {
    // Fixed shape on purpose: agent.complete is read by the UI, cost-report and
    // the replay harness, and a key that appears only sometimes forces all three
    // to tell "no verdict" apart from "an older orchestrator".
    for (const info of [undefined, {}, { verdict: null }, { verdict: "SUCCEEDED", testedHead: "HEAD" }]) {
      const detail = enrichCompleteDetail(base, info);
      expect(Object.keys(detail)).toEqual([...Object.keys(base), ...KEYS]);
      expect(detail).toMatchObject({ ...base, verdict: null, verdictSource: null, testedHead: null, wouldSuppress: false });
    }
  });

  it("carries a resolved verdict through, normalized", () => {
    const { record, assignee } = completionOf("dowtdh", "TEAM-4180");
    const detail = enrichCompleteDetail(base, {
      ...resolveVerdict(record, assignee),
      testedHead: resolveTestedHead(record),
      wouldSuppress: true,
    });
    expect(detail).toMatchObject({
      ...base,
      verdict: "CHANGES_NEEDED",
      verdictSource: "inferred",
      testedHead: record.commit_sha.toLowerCase(),
      wouldSuppress: true,
    });
    expect(detail.testedHead.startsWith("933ea6f")).toBe(true);
  });

  it("normalizes hyphen/space spellings and uppercase SHAs on the way onto the event", () => {
    expect(enrichCompleteDetail(base, { verdict: "changes-needed", testedHead: " 933EA6F ", wouldSuppress: "yes" })).toMatchObject({
      verdict: "CHANGES_NEEDED",
      testedHead: "933ea6f",
      wouldSuppress: false, // only a literal true is true
    });
  });

  it("leaves the base detail's own keys untouched", () => {
    const detail = enrichCompleteDetail({ ...base, verdict: "STALE" }, { verdict: "PASS", verdictSource: "declared" });
    expect(detail.verdict).toBe("PASS");
    expect(detail.ticketId).toBe("TEAM-4181");
  });
});
