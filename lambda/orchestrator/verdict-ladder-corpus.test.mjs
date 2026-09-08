import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GATE_PERSONAS, VERDICTS, resolveVerdict, resolveTestedHead } from "./verdict-contract.mjs";

/**
 * The ladder against EVERY gate completion the repo has vendored (TEAM-4264 F1).
 *
 * verdict-contract.test.mjs pins the prose SPELLINGS the ladder must read, from
 * two dossiers, chosen because they are the runs D1 was written for. This file
 * pins something different and it is the reason F1's remedy could be measured
 * rather than argued: what the ladder says about all six vendored runs at once.
 *
 * The widening F1 asks for is dangerous in a way the original ladder was not.
 * Since TEAM-4264 a null verdict HOLDS a gate persona's successors, so every rung
 * added to make fewer summaries null also risks reading a real PASS as a FAIL —
 * and there the cost is not "one re-verify round", it is a stalled run and a
 * human wondering why a green gate re-opened. The first widening attempted here
 * (a document-wide /\bFAIL\b/ scan) flipped ELEVEN of the twelve real
 * PASS/CHANGES_NEEDED completions below, because a gate summary's body always
 * enumerates the failures it found or fixed. The line-anchored HEADLINE rung
 * flips zero and rescues one.
 *
 * So this table is the guard on the NEXT widening, and its value is entirely in
 * being exhaustive: add a rung that reads any of these 31 records differently and
 * this file fails with the real summary in the diff. Regenerate expectations only
 * after reading the summary the row names and deciding it was previously wrong.
 */

const FIXTURES = "../../deploy/workflow-manager/toolkit/fixtures";
const RUNS = ["c2uqki", "dowtdh", "f50ucz", "iczquj", "sffzti", "yteqfl"];

const DOSSIERS = Object.fromEntries(
  RUNS.map((name) => [
    name,
    JSON.parse(readFileSync(fileURLToPath(new URL(`${FIXTURES}/${name}-dossier.json`, import.meta.url)), "utf8")),
  ])
);

/** Every (run, ticketId) whose assignee is in GATE_PERSONAS and which completed. */
function gateCompletions() {
  const out = [];
  for (const [run, d] of Object.entries(DOSSIERS)) {
    for (const [ticketId, record] of Object.entries(d.completions || {})) {
      const ticket = (d.tickets || []).find((t) => t.ticketId === ticketId);
      if (!GATE_PERSONAS.has(ticket?.assignee)) continue;
      out.push({ run, ticketId, assignee: ticket.assignee, record });
    }
  }
  return out;
}

// [run, ticketId, persona, verdict, verdictSource, testedHead prefix]
//
// The 17 records that carry a summary at all are the interesting ones. The other
// 14 (sffzti, yteqfl) completed with an EMPTY summary — which is the plainest
// possible statement of what F1 is about: a gate persona that said nothing.
// Before TEAM-4264 all 14 released their successors.
const TABLE = [
  // ── c2uqki — the dead-code sweep run (TEAM-4247's own corpus) ───────────────
  ["c2uqki", "TEAM-4231", "code_reviewer",   "CHANGES_NEEDED", "inferred", "1b399fb"],  // "VERDICT: CHANGES NEEDED (…)"
  ["c2uqki", "TEAM-4232", "qa_verifier",     "FAIL",           "inferred", "1b399fb"],  // "**Verdict: FAIL (…)"
  ["c2uqki", "TEAM-4233", "ci_agent",        "PASS",           "inferred", "73f0056"],  // "CI VERDICT: PASS — …"
  // ── dowtdh — the run D1 exists because of: three prose-only gate verdicts ───
  ["dowtdh", "TEAM-4180", "code_reviewer",   "CHANGES_NEEDED", "inferred", "933ea6f"],
  ["dowtdh", "TEAM-4181", "qa_verifier",     "FAIL",           "inferred", "12e9ac6"],
  ["dowtdh", "TEAM-4182", "ci_agent",        "PASS",           "inferred", "12e9ac6"],  // the /\bFAIL\b/ scan flipped THIS one
  // ── f50ucz — five more spellings + the semantic-prose negative ──────────────
  ["f50ucz", "TEAM-4123", "code_reviewer",   "CHANGES_NEEDED", "inferred", "6282d52"],
  ["f50ucz", "TEAM-4124", "qa_verifier",     "PASS",           "inferred", "1e1591f"],
  ["f50ucz", "TEAM-4125", "ci_agent",        "PASS",           "inferred", "df1ed19"],
  ["f50ucz", "TEAM-4126", "release_manager", "PASS",           "inferred", "7c2391b"],  // round heading, no "verdict:" label
  ["f50ucz", "TEAM-4128", "release_manager", null,             "none",     "ff64a7d"],  // "Verdict: code deploy SUCCEEDED" — NOT a verdict
  ["f50ucz", "TEAM-4157", "ci_agent",        "PASS",           "inferred", "7c2391b"],
  // ── iczquj — where the HEADLINE rung earns its place ────────────────────────
  ["iczquj", "TEAM-3586", "code_reviewer",   "PASS",           "inferred", null],
  ["iczquj", "TEAM-3587", "qa_verifier",     "PASS",           "inferred", null],
  ["iczquj", "TEAM-3588", "ci_agent",        "PASS",           "inferred", "d231648"],  // "CI GATE: ✅ PASS —" — RESCUED by F1
  ["iczquj", "TEAM-3589", "release_manager", "PASS",           "inferred", "d231648"],
  ["iczquj", "TEAM-3591", "release_manager", null,             "none",     "f754cd3"],  // "CD COMPLETE — PR #57 merged" — NOT a verdict
  // ── sffzti / yteqfl — completed with no summary at all ──────────────────────
  ["sffzti", "TEAM-3792", "code_reviewer",   null, "none", "2d244de"],
  ["sffzti", "TEAM-3794", "qa_verifier",     null, "none", "c092e98"],
  ["sffzti", "TEAM-3796", "ci_agent",        null, "none", "e3a9678"],
  ["sffzti", "TEAM-3799", "release_manager", null, "none", "731d34c"],
  ["sffzti", "TEAM-3803", "release_manager", null, "none", "80a64ae"],
  ["yteqfl", "TEAM-4063", "code_reviewer",   null, "none", null],
  ["yteqfl", "TEAM-4064", "qa_verifier",     null, "none", "a5b4ac4"],
  ["yteqfl", "TEAM-4065", "ci_agent",        null, "none", "ade21a6"],
  ["yteqfl", "TEAM-4066", "release_manager", null, "none", "45694dd"],
  ["yteqfl", "TEAM-4068", "release_manager", null, "none", "0cf3f09"],
  ["yteqfl", "TEAM-4092", "qa_verifier",     null, "none", "16b2bd3"],
  ["yteqfl", "TEAM-4094", "ci_agent",        null, "none", "16b2bd3"],
  ["yteqfl", "TEAM-4103", "qa_verifier",     null, "none", "45694dd"],
  ["yteqfl", "TEAM-4104", "ci_agent",        null, "none", "45694dd"],
];

describe("verdict ladder — the whole vendored corpus", () => {
  it.each(TABLE)("%s %s (%s) → %s (%s)", (run, ticketId, _persona, verdict, verdictSource, headPrefix) => {
    const d = DOSSIERS[run];
    const record = d.completions[ticketId];
    const assignee = d.tickets.find((t) => t.ticketId === ticketId)?.assignee;
    expect(resolveVerdict(record, assignee)).toMatchObject({ verdict, verdictSource });
    const head = resolveTestedHead(record);
    if (headPrefix === null) expect(head).toBeNull();
    else expect(head?.startsWith(headPrefix)).toBe(true);
  });

  it("tables EVERY gate completion in all six dossiers — exhaustive or nothing", () => {
    // The point of the file. A gate completion this table does not name is one a
    // future ladder change can flip unobserved.
    const seen = gateCompletions().map((c) => `${c.run}/${c.ticketId}`);
    expect(seen.sort()).toEqual(TABLE.map(([run, id]) => `${run}/${id}`).sort());
  });

  it("the table agrees with each record's own assignee", () => {
    // Cheap guard against a copy-paste row: the persona column is not decoration,
    // it is what makes a null row readable ("a release manager said nothing").
    for (const [run, ticketId, persona] of TABLE) {
      const assignee = DOSSIERS[run].tickets.find((t) => t.ticketId === ticketId)?.assignee;
      expect(assignee, `${run}/${ticketId}`).toBe(`agentcore_hub_${persona}`);
    }
  });

  it("never resolves to a value outside the enum", () => {
    for (const { run, ticketId, record, assignee } of gateCompletions()) {
      const { verdict } = resolveVerdict(record, assignee);
      if (verdict !== null) expect(VERDICTS, `${run}/${ticketId}`).toContain(verdict);
    }
  });

  it("reads 15 of the 17 summarised gate completions, and holds on the other 2", () => {
    // The headline number F1 was measured on, asserted rather than described.
    // 14 resolved before the HEADLINE rung; iczquj TEAM-3588 is the one it
    // rescued; zero flipped. The two that stay null are release managers stating
    // a finished deploy in words the enum has no room for ("code deploy
    // SUCCEEDED", "CD COMPLETE") — deliberately NOT a rung, because inventing a
    // semantic PASS is how a mis-read verdict ships over a real failure. Both are
    // free in practice: they had no open successors, and applyVerdictHold files
    // nothing for an UNKNOWN verdict with nothing to hold.
    const summarised = gateCompletions().filter((c) => (c.record?.summary || "").trim() !== "");
    const resolved = summarised.filter((c) => resolveVerdict(c.record, c.assignee).verdict !== null);
    expect(summarised).toHaveLength(17);
    expect(resolved).toHaveLength(15);
    expect(summarised.filter((c) => resolveVerdict(c.record, c.assignee).verdict === null).map((c) => c.ticketId).sort())
      .toEqual(["TEAM-3591", "TEAM-4128"]);
  });

  it("exactly ONE corpus record resolves on the HEADLINE rung, and it is the rescue", () => {
    // Provenance, not just verdicts. `matched` says which rung answered: rungs 1-2
    // leave a "verdict:" label or a "round N" heading in it, so what remains is
    // the HEADLINE rung. Pinning the SET matters more than the count — it is what
    // makes the adversarial pass below meaningful, because a rung that answers for
    // exactly one record is a rung only that record can regress.
    const headline = gateCompletions()
      .filter((c) => (c.record?.summary || "").trim() !== "")
      .map((c) => ({ id: `${c.run}/${c.ticketId}`, ...resolveVerdict(c.record, c.assignee) }))
      .filter((r) => r.verdict !== null && r.matched && !/verdict\s*:/i.test(r.matched) && !/round\s*\d+/i.test(r.matched));
    expect(headline.map((r) => r.id)).toEqual(["iczquj/TEAM-3588"]);
    expect(headline[0].verdict).toBe("PASS");
  });

  it("appending a zero-count line to any record changes NOTHING (TEAM-4285)", () => {
    // The adversarial guard on the count-payload rule. Every gate summary in the
    // wild eventually grows a "FAIL: 0" line, and before TEAM-4285 that line was
    // read as a FAIL headline that out-severed the persona's real answer.
    //
    // The teeth are in ONE record and that is worth stating plainly: without the
    // fix this flips iczquj/TEAM-3588 from PASS to FAIL. The other 14 resolve at
    // rungs 1-2, which are document-wide and first-hit-wins, so an appended line
    // cannot reach them — TEAM-3588 is the corpus's only HEADLINE-rung resolution
    // and therefore the only record that can prove the rule.
    let compared = 0;
    for (const c of gateCompletions()) {
      const base = resolveVerdict(c.record, c.assignee);
      if (base.verdict === null) continue;
      const adversarial = { ...c.record, summary: `${c.record.summary}\nFAIL: 0\nSKIP: 0` };
      expect(resolveVerdict(adversarial, c.assignee).verdict, `${c.run}/${c.ticketId}`).toBe(base.verdict);
      compared++;
    }
    expect(compared).toBe(15);
  });

  it("every unsummarised gate completion is a null verdict, not a PASS", () => {
    // 14 records, all of sffzti and yteqfl. Nothing to read is exactly the case
    // F1 inverted: before TEAM-4264 each of these released its successor.
    const blank = gateCompletions().filter((c) => (c.record?.summary || "").trim() === "");
    expect(blank).toHaveLength(14);
    for (const c of blank) {
      expect(resolveVerdict(c.record, c.assignee), `${c.run}/${c.ticketId}`)
        .toMatchObject({ verdict: null, verdictSource: "none" });
    }
  });
});
