import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BRANCH_TOKEN_RE,
  CANONICAL_BRANCH_RE,
  TICKET_PLAN_VALIDATOR_MODES,
  canonicalBranchFor,
  findBranchTokens,
  isAdvisoryTicket,
  isRequirementsRoot,
  normalizeTicketPlanValidatorMode,
  parseTicketPlanTickets,
  rewriteBranchNames,
  validateTicketPlan,
} from "./ticket-plan-validator.mjs";

/**
 * The ticket-plan contract, pinned against the REAL c2uqki plan (TEAM-4248 D3).
 *
 * A synthetic two-ticket plan proves nothing here. The defect is that the plan
 * an analyst submits never contains its own root — the analyst writes it FROM
 * its requirements ticket — so "the first unblocked entry is the root" is a
 * heuristic that exempts exactly the offender it is meant to catch. The fixture
 * below is c2uqki's board as the dossier recorded it, and the plan cases use it
 * WITHOUT the root entry, which is the shape submit_ticket_plan actually sees.
 */

const dossier = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../deploy/workflow-manager/toolkit/fixtures/c2uqki-dossier.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);

const ticketsById = new Map(
  (dossier.tickets || []).filter((t) => t.ticketId).map((t) => [t.ticketId, t]),
);
const c2uqki = (id) => {
  const t = ticketsById.get(id);
  if (!t) throw new Error(`fixture drift: ${id} is not in c2uqki-dossier.json`);
  return t;
};

/**
 * The plan as SUBMITTED: the analyst's own ticket (TEAM-4229) is absent, so the
 * first entry is the sweeper TEAM-4230 with blocked_by=[] — the offender.
 */
const c2uqkiSubmittedPlan = () => [
  { ...c2uqki("TEAM-4230"), status: "open" },
  { ...c2uqki("TEAM-4231"), status: "open" },
  { ...c2uqki("TEAM-4232"), status: "open" },
  { ...c2uqki("TEAM-4233"), status: "open" },
];

describe("normalizeTicketPlanValidatorMode", () => {
  it("defaults UNSET to shadow and falls unrecognized values to off", () => {
    expect(normalizeTicketPlanValidatorMode(undefined)).toBe("shadow");
    expect(normalizeTicketPlanValidatorMode(null)).toBe("shadow");
    expect(normalizeTicketPlanValidatorMode("")).toBe("shadow");
    expect(normalizeTicketPlanValidatorMode("   ")).toBe("shadow");
    // A typo is an operator who meant something specific and got it wrong.
    expect(normalizeTicketPlanValidatorMode("yes")).toBe("off");
    expect(normalizeTicketPlanValidatorMode("on")).toBe("off");
    expect(normalizeTicketPlanValidatorMode("true")).toBe("off");
  });

  it("accepts every mode case- and whitespace-insensitively", () => {
    expect(normalizeTicketPlanValidatorMode("off")).toBe("off");
    expect(normalizeTicketPlanValidatorMode("shadow")).toBe("shadow");
    expect(normalizeTicketPlanValidatorMode("ENFORCE")).toBe("enforce");
    expect(normalizeTicketPlanValidatorMode("  Shadow  ")).toBe("shadow");
    expect(TICKET_PLAN_VALIDATOR_MODES).toEqual(["off", "shadow", "enforce"]);
  });
});

describe("parseTicketPlanTickets", () => {
  it("returns the array for an array, a JSON string and a {tickets} wrapper", () => {
    const arr = [{ title: "a" }, { title: "b" }];
    expect(parseTicketPlanTickets(arr)).toBe(arr);
    expect(parseTicketPlanTickets(JSON.stringify(arr))).toEqual(arr);
    expect(parseTicketPlanTickets({ tickets: arr })).toBe(arr);
    expect(parseTicketPlanTickets(JSON.stringify({ tickets: arr }))).toEqual(arr);
  });

  it("counts TICKETS, not the characters of the JSON string main.py sends", () => {
    // The ticket_count bug: main.py declares `tickets: str`, so tickets.length
    // has been reporting the character count of the serialized plan.
    const json = JSON.stringify(c2uqkiSubmittedPlan());
    expect(json.length).toBeGreaterThan(100);
    expect(parseTicketPlanTickets(json)).toHaveLength(4);
  });

  it("returns [] for nothing sent and null for something unusable", () => {
    expect(parseTicketPlanTickets(undefined)).toEqual([]);
    expect(parseTicketPlanTickets(null)).toEqual([]);
    expect(parseTicketPlanTickets("")).toEqual([]);
    // Non-empty but not a plan: the caller must throw, not save [].
    expect(parseTicketPlanTickets("not json at all")).toBeNull();
    expect(parseTicketPlanTickets('{"nope": 1}')).toBeNull();
    expect(parseTicketPlanTickets("42")).toBeNull();
    expect(parseTicketPlanTickets(7)).toBeNull();
  });
});

describe("isRequirementsRoot", () => {
  it("matches the analyst assignee or an explicit requirements phase", () => {
    expect(isRequirementsRoot(c2uqki("TEAM-4229"))).toBe(true);
    expect(isRequirementsRoot({ assignee: "AGENTCORE_HUB_REQUIREMENTS_ANALYST" })).toBe(true);
    expect(isRequirementsRoot({ phase: "requirements" })).toBe(true);
    expect(isRequirementsRoot({ assignee: "agentcore_hub_code_sweeper" })).toBe(false);
    expect(isRequirementsRoot({})).toBe(false);
  });
});

describe("isAdvisoryTicket", () => {
  it("requires the exact label word", () => {
    expect(isAdvisoryTicket({ labels: ["advisory"] })).toBe(true);
    expect(isAdvisoryTicket({ labels: [" ADVISORY "] })).toBe(true);
    expect(isAdvisoryTicket({ labels: ["advisory-ish"] })).toBe(false);
    expect(isAdvisoryTicket({ labels: [] })).toBe(false);
    expect(isAdvisoryTicket({ labels: "advisory" })).toBe(false);
    expect(isAdvisoryTicket({})).toBe(false);
  });

  it("never applies to a fix ticket or a human gate, whatever the label says", () => {
    expect(isAdvisoryTicket({ labels: ["advisory"], spawnedBy: { kind: "qa_fix" } })).toBe(false);
    expect(isAdvisoryTicket({ labels: ["advisory"], spawned_by_kind: "review_fix" })).toBe(false);
    expect(isAdvisoryTicket({ labels: ["advisory"], assignee: "human:product-owner" })).toBe(false);
  });
});

describe("validateTicketPlan — unblocked-non-root", () => {
  it("names TEAM-4230 and TEAM-4229", () => {
    // THE c2uqki defect. The plan as submitted has no root entry at all: its
    // first entry IS the offender, at blocked_by=[]. A first-entry heuristic
    // would call TEAM-4230 the root and pass the plan.
    const plan = c2uqkiSubmittedPlan();
    expect(plan[0].ticketId).toBe("TEAM-4230");
    expect(plan[0].blockedBy).toEqual([]);

    const { ok, violations } = validateTicketPlan(plan, {
      rootTicketId: "TEAM-4229",
      rootStatus: "open",
    });

    expect(ok).toBe(false);
    const unblocked = violations.filter((v) => v.code === "unblocked-non-root");
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0].ticketRef).toBe("TEAM-4230");
    expect(unblocked[0].message).toContain("TEAM-4230");
    expect(unblocked[0].message).toContain("TEAM-4229");
    // TEAM-4264 F8: the one violation that MAY reject a plan.
    expect(unblocked[0].severity).toBe("error");
  });

  it("fails open entirely once the requirements root is done", () => {
    const { violations } = validateTicketPlan(c2uqkiSubmittedPlan(), {
      rootTicketId: "TEAM-4229",
      rootStatus: "done",
    });
    expect(violations.filter((v) => v.code === "unblocked-non-root")).toHaveLength(0);
  });

  it("exempts a root found by ROLE inside the plan and flags the rest", () => {
    // A plan that DOES carry its root (a replay, or an analyst that includes it).
    const plan = [c2uqki("TEAM-4229"), ...c2uqkiSubmittedPlan()];
    const { violations } = validateTicketPlan(plan, { rootStatus: "open" });
    const unblocked = violations.filter((v) => v.code === "unblocked-non-root");
    expect(unblocked.map((v) => v.ticketRef)).toEqual(["TEAM-4230"]);
    expect(unblocked[0].message).toContain("TEAM-4229");
  });

  it("says 'the requirements ticket' when no root can be resolved at all", () => {
    const { violations } = validateTicketPlan(
      [{ title: "Design the thing", assignee: "agentcore_hub_backend_designer", blockedBy: [] }],
      {},
    );
    const unblocked = violations.filter((v) => v.code === "unblocked-non-root");
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0].message).toContain("the requirements ticket");
    // No ticketId yet at plan time — the title is how the analyst finds it.
    expect(unblocked[0].ticketRef).toBe("Design the thing");
  });

  it("advisory tickets are exempt", () => {
    const plan = [
      {
        title: "Advisory: tidy the legacy shim",
        assignee: "agentcore_hub_backend_dev",
        blockedBy: [],
        labels: ["advisory"],
      },
      // ...and a fix ticket, chained by the fix contract rather than the plan.
      {
        ticketId: "TEAM-4241",
        title: c2uqki("TEAM-4241").title,
        assignee: "agentcore_hub_code_sweeper",
        blockedBy: [],
        spawnedBy: { kind: "review_fix" },
      },
    ];
    const { ok, violations } = validateTicketPlan(plan, {
      rootTicketId: "TEAM-4229",
      rootStatus: "open",
    });
    expect(violations.filter((v) => v.code === "unblocked-non-root")).toHaveLength(0);
    expect(ok).toBe(true);
  });

  it("never throws and passes an empty plan", () => {
    expect(validateTicketPlan(undefined, {})).toEqual({ ok: true, violations: [] });
    expect(validateTicketPlan([], {})).toEqual({ ok: true, violations: [] });
    expect(validateTicketPlan("nonsense", {})).toEqual({ ok: true, violations: [] });
  });
});

describe("branch tokens", () => {
  it("finds the invented name even inside backticks, and not the real one", () => {
    // c2uqki wrote it as: ...on branch `chore/dead-code-sweep-2026-09-07` -> main
    const desc = c2uqki("TEAM-4231").description;
    expect(desc).toContain("chore/dead-code-sweep-2026-09-07");
    expect(findBranchTokens(desc)).toContain("chore/dead-code-sweep-2026-09-07");
    expect(CANONICAL_BRANCH_RE.test("chore/dead-code-sweep-2026-09-07")).toBe(false);

    // The branch that really existed is canonical and must not be flagged.
    expect(CANONICAL_BRANCH_RE.test("feature/TEAM-4230-code-sweeper")).toBe(true);
    const { violations } = validateTicketPlan(
      [{ ticketId: "TEAM-4231", description: "Review feature/TEAM-4230-code-sweeper", blockedBy: ["TEAM-4230"] }],
      { rootTicketId: "TEAM-4229", rootStatus: "open" },
    );
    expect(violations).toHaveLength(0);
  });

  it("is a global regex that does not leak lastIndex between calls", () => {
    expect(BRANCH_TOKEN_RE.flags).toContain("g");
    const text = "see chore/one and chore/two";
    expect(findBranchTokens(text)).toEqual(["chore/one", "chore/two"]);
    expect(findBranchTokens(text)).toEqual(["chore/one", "chore/two"]);
  });

  it("flags an invented branch on the real c2uqki review ticket", () => {
    const { violations } = validateTicketPlan([c2uqki("TEAM-4231")], {
      rootTicketId: "TEAM-4229",
      rootStatus: "done",
      knownBranches: ["feature/TEAM-4230-code-sweeper"],
    });
    const invented = violations.filter((v) => v.code === "invented-branch");
    expect(invented.length).toBeGreaterThan(0);
    expect(invented[0].message).toContain("chore/dead-code-sweep-2026-09-07");
    expect(invented[0].message).toContain("feature/<ticketId>-<persona-slug>");
  });

  it("does not flag a branch it was told exists", () => {
    const { violations } = validateTicketPlan(
      [{ ticketId: "T-1", description: "work on chore/legacy-thing", blockedBy: ["T-0"] }],
      { rootStatus: "done", knownBranches: ["chore/legacy-thing"] },
    );
    expect(violations).toHaveLength(0);
  });
});

/**
 * TEAM-4264 F8 — invented-branch is advisory (severity "warn"), always. Existence
 * cannot be checked from any of the three writers that call this module (none
 * holds a GitHub credential), so a token this validator does not recognize might
 * be a real, non-canonical branch (a `chore/…` sweep name, a `fix/foo`, a
 * `release/v1.2`) rather than an invention — and `knownBranches` is how a caller
 * that CAN name real branches keeps them from ever being flagged at all.
 */
describe("validateTicketPlan — invented-branch is advisory (TEAM-4264 F8)", () => {
  const plan = (branchToken, extra = {}) => [
    { ticketId: "T-1", description: `Review ${branchToken}`, blockedBy: ["T-0"], ...extra },
  ];

  it("a real non-canonical branch, named via knownBranches, is clean", () => {
    const { ok, violations } = validateTicketPlan(
      plan("chore/dead-code-sweep-2026-08-31"),
      { rootStatus: "done", knownBranches: ["chore/dead-code-sweep-2026-08-31"] },
    );
    expect(ok).toBe(true);
    expect(violations).toHaveLength(0);
  });

  it("the same token with EMPTY knownBranches is flagged, but only as severity warn", () => {
    const { ok, violations } = validateTicketPlan(
      plan("chore/dead-code-sweep-2026-08-31"),
      { rootStatus: "done", knownBranches: [] },
    );
    const invented = violations.filter((v) => v.code === "invented-branch");
    expect(invented).toHaveLength(1);
    expect(invented[0].severity).toBe("warn");
    // Advisory-only: ok is a pure function of whether any violation exists at
    // all, not of severity — a caller decides what to DO with severity.
    expect(ok).toBe(false);
  });

  it.each(["fix/foo", "release/v1.2"])("%s is clean when known, warn when not", (token) => {
    const known = validateTicketPlan(plan(token), { rootStatus: "done", knownBranches: [token] });
    expect(known.violations.filter((v) => v.code === "invented-branch")).toHaveLength(0);

    const unknown = validateTicketPlan(plan(token), { rootStatus: "done", knownBranches: [] });
    const invented = unknown.violations.filter((v) => v.code === "invented-branch");
    expect(invented).toHaveLength(1);
    expect(invented[0].severity).toBe("warn");
  });

  it("the canonical convention never flags, known or not", () => {
    const { violations } = validateTicketPlan(
      plan("feature/TEAM-4230-code-sweeper"),
      { rootStatus: "done", knownBranches: [] },
    );
    expect(violations.filter((v) => v.code === "invented-branch")).toHaveLength(0);
  });
});

describe("canonicalBranchFor", () => {
  it("slugs the agent id the way the harness does", () => {
    expect(canonicalBranchFor("TEAM-4230", "agentcore_hub_code_sweeper")).toBe(
      "feature/TEAM-4230-code-sweeper",
    );
    expect(canonicalBranchFor("TEAM-4231", "agentcore_hub_code_reviewer")).toBe(
      "feature/TEAM-4231-code-reviewer",
    );
    expect(canonicalBranchFor("TEAM-9", "agentcore_hub_backend_dev", { advisory: true })).toBe(
      "feature/TEAM-9-advisory",
    );
  });

  it("produces the branch c2uqki's sweeper actually pushed", () => {
    // The four downstream tickets all named chore/dead-code-sweep-2026-09-07;
    // this is what they should have said.
    expect(canonicalBranchFor("TEAM-4230", c2uqki("TEAM-4230").assignee)).toBe(
      "feature/TEAM-4230-code-sweeper",
    );
  });
});

describe("rewriteBranchNames", () => {
  it("rewrites an invented branch to the harness convention", () => {
    const canonical = canonicalBranchFor("TEAM-4230", "agentcore_hub_code_sweeper");
    const { text, rewrites } = rewriteBranchNames(c2uqki("TEAM-4231").description, {
      canonical,
      knownBranches: [canonical],
    });

    expect(text).not.toContain("chore/dead-code-sweep-2026-09-07");
    expect(text).toContain("feature/TEAM-4230-code-sweeper");
    expect(rewrites).toEqual([
      { from: "chore/dead-code-sweep-2026-09-07", to: "feature/TEAM-4230-code-sweeper" },
    ]);
  });

  it("leaves text untouched when there is nothing to rewrite", () => {
    const canonical = "feature/TEAM-4230-code-sweeper";
    const clean = `Review the diff on ${canonical} and report.`;
    const { text, rewrites } = rewriteBranchNames(clean, { canonical, knownBranches: [canonical] });
    expect(text).toBe(clean);
    expect(rewrites).toEqual([]);

    // A known non-canonical branch is also left alone.
    const legacy = "work on chore/legacy-thing please";
    const r2 = rewriteBranchNames(legacy, { canonical, knownBranches: ["chore/legacy-thing"] });
    expect(r2.text).toBe(legacy);
    expect(r2.rewrites).toEqual([]);
  });

  it("is a no-op without a canonical target, and never throws on junk", () => {
    expect(rewriteBranchNames("chore/x", {})).toEqual({ text: "chore/x", rewrites: [] });
    expect(rewriteBranchNames(undefined, { canonical: "feature/T-1-dev" })).toEqual({
      text: "",
      rewrites: [],
    });
  });
});
