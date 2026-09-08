import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * report_completion's completion RECORD (TEAM-4121 FR-9).
 *
 * completions/<ticket>.json is the only durable statement of how an agent knows
 * its work is done, and the orchestrator now acts on it: a fix ticket that
 * declared evidence_source=live but whose record carries no live evidence is
 * marked `unverified` and re-verified at the PR head (live-reverify.mjs). So the
 * two new fields have to be BOTH additive — a record written without them must
 * keep exactly the pre-4121 key set, or every existing consumer changes shape at
 * once — and closed: an unrecognized evidence_kind is dropped rather than stored,
 * because a downstream reader must never have to guess what a novel value meant.
 */

const h = vi.hoisted(() => ({ puts: [], warns: [] }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd?.constructor?.name === "PutObjectCommand") h.puts.push(cmd.input);
      return {};
    }
  },
  PutObjectCommand: class { constructor(input) { this.input = input; } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
  ListObjectsV2Command: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-lambda", () => ({
  // The Done transition is not under test; a plain success keeps the log quiet.
  LambdaClient: class { async send() { return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true })) }; } },
  InvokeCommand: class { constructor(input) { this.input = input; } },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  PutCommand: class { constructor(input) { this.input = input; } },
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
const { handler } = await import("./index.mjs");

/** The completion record the call wrote, parsed. */
const record = () => JSON.parse(h.puts.find((p) => p.Key?.startsWith("completions/")).Body);

const report = (extra) =>
  handler({
    tool_name: "WorkflowOutput___report_completion",
    arguments: {
      ticket_id: "TEAM-4200",
      summary: "Re-ran the expired-token repro at HEAD; 401 as expected.",
      workflow_id: "wf_1",
      agent_id: "agentcore_hub_qa_verifier",
      ...extra,
    },
  });

// Every key a pre-4121 record carries — asserted as a SET so an accidental
// addition (or rename) fails here rather than in whatever reads the record.
const BASE_KEYS = ["ticket_id", "summary", "artifacts", "branch", "commit_sha", "pr_url", "completed_at"];

beforeEach(() => {
  h.puts.length = 0;
  h.warns.length = 0;
  vi.spyOn(console, "warn").mockImplementation((...args) => h.warns.push(args.join(" ")));
});

describe("report_completion — evidence_kind / evidence_keys", () => {
  it("persists both when the agent supplies them", async () => {
    await report({ evidence_kind: "live", evidence_keys: "workflows/wf_1/qa-evidence/401.png,workflows/wf_1/qa-evidence/run.log" });
    const r = record();
    expect(r.evidence_kind).toBe("live");
    expect(r.evidence_keys).toBe("workflows/wf_1/qa-evidence/401.png,workflows/wf_1/qa-evidence/run.log");
  });

  it("a record written without them keeps exactly the pre-4121 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("blank values are the same as absent", async () => {
    await report({ evidence_kind: "   ", evidence_keys: "" });
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("normalizes case and whitespace", async () => {
    await report({ evidence_kind: " LIVE " });
    expect(record().evidence_kind).toBe("live");
  });

  it("accepts the other two kinds", async () => {
    await report({ evidence_kind: "static" });
    expect(record().evidence_kind).toBe("static");
    h.puts.length = 0;
    await report({ evidence_kind: "unit" });
    expect(record().evidence_kind).toBe("unit");
  });

  it("drops an unknown kind with a warning instead of storing it", async () => {
    await report({ evidence_kind: "vibes", evidence_keys: "qa-evidence/a.png" });
    const r = record();
    expect("evidence_kind" in r).toBe(false);
    // The keys still land — they are the weaker signal, but they are real.
    expect(r.evidence_keys).toBe("qa-evidence/a.png");
    expect(h.warns.join("\n")).toMatch(/unknown evidence_kind "vibes"/);
  });

  it("accepts an array of keys (the harness sends a comma string; a gateway may not)", async () => {
    await report({ evidence_kind: "live", evidence_keys: ["qa-evidence/a.png", "qa-evidence/b.har"] });
    expect(record().evidence_keys).toBe("qa-evidence/a.png,qa-evidence/b.har");
  });
});

// TEAM-4122 FR-4 §7.5 — the CI agent's proof that a head SHA was actually built,
// same additive-and-closed contract as evidence_kind above.
describe("report_completion — ci_status / ci_build_id / ci_head_sha", () => {
  it("persists all three when the CI agent supplies them", async () => {
    await report({ ci_status: "certified", ci_build_id: "agentcore-hub-ci:abc123", ci_head_sha: "deadbeef" });
    const r = record();
    expect(r.ci_status).toBe("certified");
    expect(r.ci_build_id).toBe("agentcore-hub-ci:abc123");
    expect(r.ci_head_sha).toBe("deadbeef");
  });

  it("a record written without them keeps exactly the pre-4122 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("accepts the other two statuses and normalizes case/whitespace", async () => {
    await report({ ci_status: "  GITHUB-ACTIONS-PROXY  " });
    expect(record().ci_status).toBe("github-actions-proxy");
    h.puts.length = 0;
    await report({ ci_status: "unverified" });
    expect(record().ci_status).toBe("unverified");
  });

  it("drops an unknown status with a warning instead of storing it", async () => {
    await report({ ci_status: "definitely-passed", ci_build_id: "abc123" });
    const r = record();
    expect("ci_status" in r).toBe(false);
    // The build id still lands — it's the weaker signal, but it's real.
    expect(r.ci_build_id).toBe("abc123");
    expect(h.warns.join("\n")).toMatch(/unknown ci_status "definitely-passed"/);
  });

  it("drops an oversized build id / head sha with a warning instead of storing it", async () => {
    await report({ ci_build_id: "x".repeat(129), ci_head_sha: "y".repeat(129) });
    const r = record();
    expect("ci_build_id" in r).toBe(false);
    expect("ci_head_sha" in r).toBe(false);
    expect(h.warns.join("\n")).toMatch(/oversized ci_build_id/);
    expect(h.warns.join("\n")).toMatch(/oversized ci_head_sha/);
  });
});

// TEAM-4246 D1 — the gate persona's verdict and the head it tested, as FIELDS.
// wf_1788731227559_dowtdh shipped over "VERDICT: CHANGES NEEDED" and then
// "VERDICT: FAIL" because neither was anything but prose. This Lambda stores only
// what the agent DECLARED — the prose ladder lives in the orchestrator's
// verdict-contract.mjs — under the same additive-and-closed contract as above.
describe("report_completion — verdict / tested_head", () => {
  it("persists both, and stamps verdict_source=declared", async () => {
    await report({ verdict: "CHANGES_NEEDED", tested_head: "933ea6f1f04a3b2c" });
    const r = record();
    expect(r.verdict).toBe("CHANGES_NEEDED");
    expect(r.verdict_source).toBe("declared");
    expect(r.tested_head).toBe("933ea6f1f04a3b2c");
  });

  it("a record written without them keeps exactly the pre-4246 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("accepts all three CHANGES_NEEDED spellings and normalizes case/whitespace", async () => {
    // The blueprints have written "CHANGES NEEDED" with a space for a year and
    // reviewGateHistory persists the hyphen form; dropping a real verdict over a
    // separator would be the worst possible reading of "closed".
    for (const raw of ["CHANGES NEEDED", "changes-needed", "  Changes_Needed  "]) {
      h.puts.length = 0;
      await report({ verdict: raw });
      expect(record().verdict, raw).toBe("CHANGES_NEEDED");
    }
  });

  it("accepts the other three verdicts", async () => {
    for (const raw of ["PASS", "fail", " BLOCKED "]) {
      h.puts.length = 0;
      await report({ verdict: raw });
      expect(record().verdict).toBe(raw.trim().toUpperCase());
    }
  });

  it("verdict allow-list drops unknown values", async () => {
    // f50ucz TEAM-4128's real summary says "Verdict: code deploy SUCCEEDED" —
    // which is not a verdict. Stored as one it would read as a passing gate.
    await report({ verdict: "SUCCEEDED", tested_head: "7c2391ba" });
    const r = record();
    expect("verdict" in r).toBe(false);
    expect("verdict_source" in r).toBe(false);
    // The head still lands — it is a separate, independently valid signal.
    expect(r.tested_head).toBe("7c2391ba");
    expect(h.warns.join("\n")).toMatch(/unknown verdict "SUCCEEDED"/);
  });

  it("tested head rejected when not a SHA", async () => {
    for (const raw of ["HEAD", "main", "not-a-sha", "abc", "z".repeat(40), "0".repeat(41)]) {
      h.puts.length = 0;
      h.warns.length = 0;
      await report({ tested_head: raw });
      expect("tested_head" in record(), raw).toBe(false);
      expect(h.warns.join("\n")).toMatch(/non-SHA tested_head/);
    }
  });

  it("tested head is clamped in the warning, never in the record", async () => {
    // A 4KB blob in the log line would be the only thing in the log line.
    await report({ tested_head: "q".repeat(5000) });
    expect("tested_head" in record()).toBe(false);
    const warn = h.warns.find((w) => w.includes("non-SHA tested_head"));
    expect(warn.length).toBeLessThan(200);
  });

  it("normalizes an uppercase SHA", async () => {
    await report({ tested_head: " 933EA6F1F0 " });
    expect(record().tested_head).toBe("933ea6f1f0");
  });

  it("blank values are the same as absent, and neither implies the other", async () => {
    await report({ verdict: "   ", tested_head: "" });
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
    // A verdict with no head, and a head with no verdict, are both legitimate.
    h.puts.length = 0;
    await report({ verdict: "PASS" });
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS, "verdict", "verdict_source"].sort());
    h.puts.length = 0;
    await report({ tested_head: "deadbeef" });
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS, "tested_head"].sort());
  });
});

// TEAM-4247 D2 — the sweep yield pair. Everything here turns on ZERO being a
// real, storable value: run wf_1788780725940_c2uqki verified 93 candidates,
// removed none, and the orchestrator now ends such a run on that number. Any
// falsiness test anywhere on this path (here, in main.py, or in the harvest)
// silently deletes the one value the feature exists for.
describe("report_completion — verified_removable / candidates", () => {
  it("persists a ZERO yield as an integer, not as absence", async () => {
    await report({ verified_removable: "0", candidates: "93" });
    const r = record();
    expect(r.verified_removable).toBe(0);
    expect(r.candidates).toBe(93);
    expect(Object.keys(r).sort()).toEqual([...BASE_KEYS, "verified_removable", "candidates"].sort());
  });

  it("persists a productive yield", async () => {
    await report({ verified_removable: "17" });
    expect(record().verified_removable).toBe(17);
  });

  it("accepts numbers as well as strings (the Lambda is called directly too)", async () => {
    await report({ verified_removable: 0, candidates: 4 });
    expect(record().verified_removable).toBe(0);
    expect(record().candidates).toBe(4);
  });

  it("a record written without them keeps exactly the pre-4247 key set", async () => {
    await report({});
    expect(Object.keys(record()).sort()).toEqual([...BASE_KEYS].sort());
  });

  it("drops anything that is not a plain non-negative integer", async () => {
    // "none" is what a model writes when it means zero, and Number("none") is
    // NaN — but Number("") is 0, which is why the emptiness test is on the raw
    // string and the shape test is a regex rather than a cast.
    for (const raw of ["none", "-1", "1.5", "12abc", "1e3", "0x0", "1,000", " ", "1234567"]) {
      h.puts.length = 0;
      h.warns.length = 0;
      await report({ verified_removable: raw });
      expect("verified_removable" in record(), raw).toBe(false);
      if (raw.trim()) expect(h.warns.join("\n"), raw).toMatch(/dropping non-integer verified_removable/);
    }
  });

  it("drops a bad candidates without losing a good verified_removable", async () => {
    await report({ verified_removable: "0", candidates: "lots" });
    const r = record();
    expect(r.verified_removable).toBe(0);
    expect("candidates" in r).toBe(false);
    expect(h.warns.join("\n")).toMatch(/dropping non-integer candidates "lots"/);
  });

  it("clamps an oversized value in the warning, never in the record", async () => {
    await report({ verified_removable: "9".repeat(5000) });
    expect("verified_removable" in record()).toBe(false);
    const warn = h.warns.find((w) => w.includes("dropping non-integer verified_removable"));
    expect(warn.length).toBeLessThan(300);
  });
});

/**
 * submit_ticket_plan — the plan's own dependency graph (TEAM-4248 D3).
 *
 * Two defects, one call. (a) `tickets` arrives as a JSON STRING (main.py declares
 * `tickets: str`), so `tickets.length` has been reporting the character count of
 * that string since the tool was written — a 4-ticket plan reported ~600. (b)
 * nothing had ever looked at the graph: c2uqki's sweeper TEAM-4230 was planned
 * with blocked_by=[] and invoked 92.3s before the analyst it depends on finished.
 *
 * The count fix is NOT flag-gated — gating a meaningless number would leave `off`
 * deliberately wrong — and an unparseable non-empty `tickets` throws in every
 * mode, because saving [] under a corrected `ticket_count: 0` would silently
 * erase a plan the analyst believes it filed.
 */

/** The plan as the analyst submits it: no root entry, first entry unblocked. */
const C2UQKI_PLAN = [
  { title: "Sweep tycenjmccann/ember for dead code", assignee: "agentcore_hub_code_sweeper", blockedBy: [] },
  { title: "Review the sweep", assignee: "agentcore_hub_code_reviewer", blockedBy: ["TEAM-4230"] },
];

/** A load of the Lambda with TICKET_PLAN_VALIDATOR set — the flag is module-scope. */
async function loadWithMode(mode) {
  vi.resetModules();
  if (mode === undefined) delete process.env.TICKET_PLAN_VALIDATOR;
  else process.env.TICKET_PLAN_VALIDATOR = mode;
  return (await import("./index.mjs")).handler;
}

const submit = (h, args) =>
  h({ tool_name: "WorkflowOutput___submit_ticket_plan", arguments: { workflow_id: "wf_1", requirements: "req", ...args } });

/** The tool result, parsed out of the MCP content envelope. */
const resultOf = (r) => JSON.parse(r.content[0].text);
/** The ticket-plan.json body this call wrote, parsed. */
const planWritten = () => JSON.parse(h.puts.find((p) => p.Key?.endsWith("/ticket-plan.json")).Body);

describe("submit_ticket_plan — ticket_count", () => {
  it("counts TICKETS, not the characters of the JSON string main.py sends", async () => {
    const handler = await loadWithMode("off");
    const json = JSON.stringify(C2UQKI_PLAN);
    expect(json.length).toBeGreaterThan(100); // the number it used to report
    expect(resultOf(await submit(handler, { tickets: json })).ticket_count).toBe(2);
    // ...and the parsed array is what gets stored, not the string.
    expect(planWritten().tickets).toEqual(C2UQKI_PLAN);
  });

  it("counts an array argument the same way (the Lambda is called directly too)", async () => {
    const handler = await loadWithMode("off");
    expect(resultOf(await submit(handler, { tickets: C2UQKI_PLAN })).ticket_count).toBe(2);
  });

  it("throws on an unparseable non-empty tickets in EVERY mode, and saves nothing", async () => {
    for (const mode of ["off", "shadow", "enforce"]) {
      const handler = await loadWithMode(mode);
      h.puts.length = 0;
      const r = await submit(handler, { tickets: "Ticket 1: sweep the repo" });
      expect(r.isError, mode).toBe(true);
      expect(r.content[0].text, mode).toContain("'tickets' must be a JSON array of ticket objects");
      expect(h.puts.filter((p) => p.Key?.endsWith("/ticket-plan.json")), mode).toHaveLength(0);
    }
  });

  it("treats absent/empty tickets as an empty plan, as before", async () => {
    const handler = await loadWithMode("off");
    expect(resultOf(await submit(handler, {})).ticket_count).toBe(0);
    expect(resultOf(await submit(handler, { tickets: "" })).ticket_count).toBe(0);
  });
});

describe("submit_ticket_plan — TICKET_PLAN_VALIDATOR", () => {
  it("off: the result carries no warnings and the plan is saved", async () => {
    const handler = await loadWithMode("off");
    const r = resultOf(await submit(handler, { tickets: C2UQKI_PLAN, root_ticket_id: "TEAM-4229" }));
    expect("warnings" in r).toBe(false);
    expect(r.status).toBe("saved");
    expect(Object.keys(r).sort()).toEqual(["location", "message", "status", "ticket_count"]);
  });

  it("shadow: saves the plan AND names both the offender and the root", async () => {
    const handler = await loadWithMode("shadow");
    const r = resultOf(await submit(handler, { tickets: C2UQKI_PLAN, root_ticket_id: "TEAM-4229" }));
    expect(r.status).toBe("saved");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("TEAM-4229");
    expect(r.warnings[0]).toContain("Sweep tycenjmccann/ember for dead code");
    expect(planWritten().tickets).toEqual(C2UQKI_PLAN);
  });

  it("enforce: rejects and writes NO S3 object", async () => {
    const handler = await loadWithMode("enforce");
    h.puts.length = 0;
    const r = await submit(handler, { tickets: C2UQKI_PLAN, root_ticket_id: "TEAM-4229" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Ticket plan rejected");
    expect(r.content[0].text).toContain("TEAM-4229");
    expect(h.puts.filter((p) => p.Key?.endsWith("/ticket-plan.json"))).toHaveLength(0);
  });

  it("unset defaults to shadow", async () => {
    const handler = await loadWithMode(undefined);
    const r = resultOf(await submit(handler, { tickets: C2UQKI_PLAN, root_ticket_id: "TEAM-4229" }));
    expect(r.status).toBe("saved");
    expect(r.warnings).toHaveLength(1);
  });

  it("an unrecognized mode falls to off, not to enforce", async () => {
    const handler = await loadWithMode("yes");
    const r = resultOf(await submit(handler, { tickets: C2UQKI_PLAN, root_ticket_id: "TEAM-4229" }));
    expect("warnings" in r).toBe(false);
  });

  it("a correctly chained plan is clean even under enforce", async () => {
    const handler = await loadWithMode("enforce");
    const fixed = [
      { ...C2UQKI_PLAN[0], blockedBy: ["TEAM-4229"] },
      C2UQKI_PLAN[1],
    ];
    const r = resultOf(await submit(handler, { tickets: fixed, root_ticket_id: "TEAM-4229" }));
    expect(r.status).toBe("saved");
    expect("warnings" in r).toBe(false);
  });

  it("fails open once the root is done, so a replay is not rejected", async () => {
    const handler = await loadWithMode("enforce");
    const r = resultOf(await submit(handler, {
      tickets: C2UQKI_PLAN, root_ticket_id: "TEAM-4229", root_status: "done",
    }));
    expect(r.status).toBe("saved");
  });
});

/**
 * TEAM-4264 F8 — invented-branch (severity "warn") may never reject a plan, in
 * any mode; only unblocked-non-root (severity "error") may. The root is DONE in
 * every case below, so unblocked-non-root cannot fire and the only violation on
 * the board is the branch one.
 */
describe("submit_ticket_plan — invented-branch is advisory, unblocked-non-root is not (TEAM-4264 F8)", () => {
  const INVENTED_BRANCH_PLAN = [
    { ticketId: "T-1", title: "Review", description: "Review chore/dead-code-sweep-2026-09-07", blockedBy: ["T-0"] },
  ];

  it("enforce + ONLY invented-branch: the plan is SAVED, warnings[] present, isError falsy", async () => {
    const handler = await loadWithMode("enforce");
    h.puts.length = 0;
    const r = await submit(handler, { tickets: INVENTED_BRANCH_PLAN, root_ticket_id: "TEAM-4229", root_status: "done" });
    expect(r.isError).toBeFalsy();
    const body = resultOf(r);
    expect(body.status).toBe("saved");
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain("chore/dead-code-sweep-2026-09-07");
    expect(h.puts.filter((p) => p.Key?.endsWith("/ticket-plan.json"))).toHaveLength(1);
  });

  it("enforce + unblocked-non-root: still isError true, nothing saved", async () => {
    const handler = await loadWithMode("enforce");
    h.puts.length = 0;
    const r = await submit(handler, { tickets: C2UQKI_PLAN, root_ticket_id: "TEAM-4229" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Ticket plan rejected");
    expect(h.puts.filter((p) => p.Key?.endsWith("/ticket-plan.json"))).toHaveLength(0);
  });

  it("enforce + BOTH: rejects on the error violation, and the rejection message does not include the warn one", async () => {
    const handler = await loadWithMode("enforce");
    h.puts.length = 0;
    const mixed = [
      { ticketId: "T-1", title: "Sweep", description: "Review chore/dead-code-sweep-2026-09-07", blockedBy: [] },
    ];
    const r = await submit(handler, { tickets: mixed, root_ticket_id: "TEAM-4229" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("TEAM-4229"); // the unblocked-non-root violation
    expect(r.content[0].text).not.toContain("chore/dead-code-sweep-2026-09-07"); // the warn one is excluded
    expect(h.puts.filter((p) => p.Key?.endsWith("/ticket-plan.json"))).toHaveLength(0);
  });

  it("off: the result is key-for-key today's — no warnings key, plan saved", async () => {
    const handler = await loadWithMode("off");
    const r = resultOf(await submit(handler, { tickets: INVENTED_BRANCH_PLAN, root_ticket_id: "TEAM-4229", root_status: "done" }));
    expect("warnings" in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual(["location", "message", "status", "ticket_count"]);
  });

  it("shadow: console.warn fires, but the plan still saves", async () => {
    const handler = await loadWithMode("shadow");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = resultOf(await submit(handler, { tickets: INVENTED_BRANCH_PLAN, root_ticket_id: "TEAM-4229", root_status: "done" }));
    expect(r.status).toBe("saved");
    expect(r.warnings).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("plan violation"))).toBe(true);
    warn.mockRestore();
  });
});
