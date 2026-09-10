import { describe, it, expect } from "vitest";
import { mapJiraIssueToTicket } from "./index.mjs";
import { renderFixContractBlock } from "./fix-contract.mjs";

/**
 * mapJiraIssueToTicket (index.mjs) unit tests — this file holds them all, not
 * just the fix-label ones its name suggests.
 *
 * TEAM-4113 (prod-Jira fix) — a fix ticket's origin `kind` rides a `fix:<kind>`
 * label in Jira (createTicket in agentcore-hub-jira; Jira has no arbitrary
 * columns). mapJiraIssueToTicket must reconstruct `spawnedBy` from it so the
 * rework-loop cap + completion open-fix re-verify see fix tickets in Jira mode
 * exactly as they do in DynamoDB mode. Without this, isReworkFix is always
 * false in prod and the cap counts zero rounds forever.
 *
 * TEAM-4384 — the mapper must also carry `updatedAt` (Jira's `updated` field),
 * since reconcile-sweep.mjs's parkedLongEnough() reads it and a Jira-mode row
 * that never had it made that predicate vacuously true. See the describe below.
 */

const issue = (labels) => ({
  key: "TEAM-9",
  fields: { summary: "s", status: { name: "Done" }, labels, issuetype: { name: "Task" }, description: null },
});

describe("mapJiraIssueToTicket — fix:<kind> label → spawnedBy", () => {
  it("reconstructs spawnedBy.kind from a fix:qa_fix label", () => {
    const t = mapJiraIssueToTicket(issue(["wf:run1", "agent:agentcore_hub_backend_dev", "fix:qa_fix"]));
    expect(t.spawnedBy).toEqual({ kind: "qa_fix" });
  });

  it("handles review_fix and codex_fix", () => {
    expect(mapJiraIssueToTicket(issue(["fix:review_fix"])).spawnedBy).toEqual({ kind: "review_fix" });
    expect(mapJiraIssueToTicket(issue(["fix:codex_fix"])).spawnedBy).toEqual({ kind: "codex_fix" });
  });

  it("no fix label → no spawnedBy (undefined, not a fix ticket)", () => {
    expect(mapJiraIssueToTicket(issue(["wf:run1", "agent:agentcore_hub_backend_dev"])).spawnedBy).toBeUndefined();
  });

  it("empty labels → no spawnedBy", () => {
    expect(mapJiraIssueToTicket(issue([])).spawnedBy).toBeUndefined();
  });
});

/**
 * TEAM-4121 FR-8 — the rest of the contract, read back out of Jira.
 *
 * Jira has no arbitrary columns, so the jira tools Lambda writes the contract as
 * labels (`origin:` `evidence:` `phase:` `contract:incomplete` `reverify:`) plus
 * a `# fix-contract v1` block at the head of the description. This mapper is the
 * ONLY place that turns those back into the record shape every downstream reader
 * expects (completion's per-phase open-fix gate reads `phase`, the rework cap
 * reads `spawnedBy`), so each carrier is pinned here.
 *
 * LABELS WIN over the block on conflict: a label was stamped by the Lambda from
 * validated input, while the block is free text a human can rewrite in the Jira
 * UI.
 */
describe("mapJiraIssueToTicket — the FR-8 contract carriers", () => {
  /** An issue whose description is the ADF the jira Lambda writes: block, then prose. */
  const withBlock = (labels, contract, meta, prose = "The final diff regresses the expired-token path.") => ({
    key: "TEAM-9",
    fields: {
      summary: "s",
      status: { name: "To Do" },
      labels,
      issuetype: { name: "Task" },
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "codeBlock", attrs: { language: "yaml" }, content: [{ type: "text", text: renderFixContractBlock(contract, meta) }] },
          { type: "paragraph", content: [{ type: "text", text: prose }] },
        ],
      },
    },
  });

  const CONTRACT = {
    version: 1,
    invariant: "an expired token yields 401, never 500",
    evidenceSource: "live",
    evidenceRepro: "curl -H 'Authorization: Bearer expired' /api/me",
    citedLocation: ["src/auth.ts:88", "src/auth.ts:120-134"],
    siblingScope: "do not touch the session store",
  };

  it("origin:<id> lands on the origin key each kind uses", () => {
    expect(mapJiraIssueToTicket(issue(["fix:ship_fix", "origin:TEAM-1"])).spawnedBy).toEqual({
      kind: "ship_fix",
      shipTicketId: "TEAM-1",
    });
    // ci_fix and sync_fix are both filed by the CI agent off the same build
    // ticket, so they share ciTicketId.
    expect(mapJiraIssueToTicket(issue(["fix:ci_fix", "origin:TEAM-1"])).spawnedBy).toEqual({
      kind: "ci_fix",
      ciTicketId: "TEAM-1",
    });
    expect(mapJiraIssueToTicket(issue(["fix:sync_fix", "origin:TEAM-1"])).spawnedBy).toEqual({
      kind: "sync_fix",
      ciTicketId: "TEAM-1",
    });
  });

  it("phase:<p> becomes the phase stamp the completion open-fix gate keys on (F7)", () => {
    const t = mapJiraIssueToTicket(issue(["fix:ship_fix", "origin:TEAM-1", "phase:ship"]));
    expect(t.phase).toBe("ship");
  });

  it("evidence:<src> becomes fixContract.evidenceSource", () => {
    const t = mapJiraIssueToTicket(issue(["fix:qa_fix", "evidence:live"]));
    expect(t.fixContract).toEqual({ version: 1, evidenceSource: "live" });
  });

  it("contract:incomplete records the fact, not an invented field list", () => {
    // Which fields were missing exists only in the Lambda's own log, so the
    // mapper must not fabricate a list here.
    const t = mapJiraIssueToTicket(issue(["fix:qa_fix", "contract:incomplete"]));
    expect(t.fixContract).toEqual({ version: 1, warnings: ["<unparsed>"] });
  });

  it("reverify:<fixId> marks a re-verification, not a new rework round", () => {
    const t = mapJiraIssueToTicket(issue(["fix:qa_fix", "origin:TEAM-1", "reverify:TEAM-9"]));
    expect(t.spawnedBy).toEqual({ kind: "qa_fix", qaTicketId: "TEAM-1", reverify: true, rearmOf: "TEAM-9" });
  });

  it("parses the description block and hands downstream only the prose", () => {
    const t = mapJiraIssueToTicket(
      withBlock(["fix:ship_fix", "origin:TEAM-50", "phase:ship", "evidence:live"], CONTRACT, {
        kind: "ship_fix",
        originId: "TEAM-50",
        phase: "ship",
      })
    );
    expect(t.fixContract).toEqual(CONTRACT);
    // The block is machine metadata — the agent prompt gets the body alone.
    expect(t.description).toBe("The final diff regresses the expired-token path.");
  });

  it("falls back to the block's kind-origin/phase when the labels are absent", () => {
    const t = mapJiraIssueToTicket(
      withBlock(["fix:ship_fix"], CONTRACT, { kind: "ship_fix", originId: "TEAM-50", phase: "ship" })
    );
    expect(t.spawnedBy).toEqual({ kind: "ship_fix", shipTicketId: "TEAM-50" });
    expect(t.phase).toBe("ship");
  });

  it("labels WIN over the block on conflict", () => {
    // A human edited the block in the Jira UI; the labels are the Lambda's own
    // validated stamp, so they decide.
    const t = mapJiraIssueToTicket(
      withBlock(
        ["fix:ship_fix", "origin:TEAM-100", "phase:review", "evidence:static"],
        CONTRACT,
        { kind: "qa_fix", originId: "TEAM-50", phase: "ship" }
      )
    );
    expect(t.spawnedBy).toEqual({ kind: "ship_fix", shipTicketId: "TEAM-100" });
    expect(t.phase).toBe("review");
    expect(t.fixContract.evidenceSource).toBe("static");
    // Everything the labels don't carry still comes from the block.
    expect(t.fixContract.invariant).toBe(CONTRACT.invariant);
    expect(t.fixContract.citedLocation).toEqual(CONTRACT.citedLocation);
  });

  it("an unknown fix kind invents no origin key", () => {
    const t = mapJiraIssueToTicket(issue(["fix:not_a_real_kind", "origin:TEAM-1"]));
    expect(t.spawnedBy).toEqual({ kind: "not_a_real_kind" });
  });

  it("a non-fix ticket's description is never trimmed, even if it looks like a block", () => {
    const t = mapJiraIssueToTicket(
      withBlock(["wf:run1"], CONTRACT, { kind: "ship_fix", originId: "TEAM-50" })
    );
    expect(t.fixContract).toBeUndefined();
    expect(t.description).toContain("# fix-contract v1");
  });

  it("no contract labels and no block → the mapping is exactly what it was before FR-8", () => {
    const t = mapJiraIssueToTicket(issue(["wf:run1", "agent:agentcore_hub_backend_dev", "fix:qa_fix"]));
    expect(t.spawnedBy).toEqual({ kind: "qa_fix" });
    expect("phase" in t).toBe(false);
    expect("fixContract" in t).toBe(false);
    expect(t.description).toBe("");
  });
});

/**
 * TEAM-4384 — Jira's `updated` field maps onto updatedAt, ISO-normalised, so a
 * Jira-mode ticket carries the same last-touched timestamp DynamoDB-mode rows
 * always have. reconcile-sweep.mjs's parkedLongEnough() reads exactly this
 * field; without it, every Jira-mode sibling took its fail-open branch.
 */
describe("mapJiraIssueToTicket — TEAM-4384: Jira `updated` → updatedAt", () => {
  const issueWithUpdated = (updated) => ({
    key: "TEAM-9",
    fields: { summary: "s", status: { name: "Done" }, labels: [], issuetype: { name: "Task" }, description: null, updated },
  });

  it("maps fields.updated onto updatedAt, normalised to ISO", () => {
    const t = mapJiraIssueToTicket(issueWithUpdated("2026-09-10T12:34:56.789+0000"));
    expect(t.updatedAt).toBe("2026-09-10T12:34:56.789Z");
  });

  it("converts a non-zero offset rather than truncating it", () => {
    const t = mapJiraIssueToTicket(issueWithUpdated("2026-09-10T12:34:56.789+0100"));
    expect(t.updatedAt).toBe("2026-09-10T11:34:56.789Z");
  });

  it("omits updatedAt when the issue carries no `updated` field", () => {
    const t = mapJiraIssueToTicket(issueWithUpdated(undefined));
    expect(t.updatedAt).toBeUndefined();
  });

  it("omits updatedAt for an unparsable `updated` (no RangeError from toISOString)", () => {
    expect(() => mapJiraIssueToTicket(issueWithUpdated("not a date"))).not.toThrow();
    const t = mapJiraIssueToTicket(issueWithUpdated("not a date"));
    expect(t.updatedAt).toBeUndefined();
  });
});
