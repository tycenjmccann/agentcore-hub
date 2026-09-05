import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4099 F3 — the authz floor on human-review-gate decisions, JIRA twin.
 *
 * Same defect, same fix, different substrate: this Lambda is the live tool path when
 * TICKET_PROVIDER=jira (prod), and it identifies a human-review gate by its
 * `reviewer:<who>` LABEL rather than a `human:` assignee. Kept in lock-step with
 * lambda/agentcore-hub-tickets/transition-authz.test.mjs.
 *
 * Contract under test: an agent (no `_caller` envelope marker) cannot move a
 * reviewer-labelled ticket out of In Review or to Done, a trusted server-side caller
 * can, and an ordinary agent ticket is unaffected — including the cost property that
 * the trusted path skips the extra Jira read it does not need.
 *
 * Harness: real handler over a stubbed global fetch (jiraFetch's only seam), S3
 * roster read mocked away.
 */

const h = vi.hoisted(() => ({
  state: {
    /** `${method} ${path}` for every Jira call. */
    calls: /** @type {string[]} */ ([]),
    /** Body served to the issue read: fields.labels + fields.status.name. */
    labels: /** @type {string[]} */ ([]),
    status: "In Review",
    /** Transitions offered by GET .../transitions. */
    transitions: /** @type {any[]} */ ([]),
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { throw new Error("NoSuchKey"); } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
}));

const GATE = "TEAM-19";
const DEV = "TEAM-11";

let handler;

const asAgent = (parameters) => handler({ tool_name: "Tickets___transition_ticket", parameters });
const asTrusted = (parameters, caller = "console") =>
  handler({ tool_name: "Tickets___transition_ticket", _caller: caller, parameters });

const transitionCalls = () => h.state.calls.filter((c) => c.startsWith("POST") && c.includes("/transitions"));
const issueReads = () => h.state.calls.filter((c) => c.startsWith("GET") && c.includes("fields="));

beforeEach(async () => {
  h.state.calls.length = 0;
  h.state.labels = ["reviewer:reviewer@example.com"];
  h.state.status = "In Review";
  h.state.transitions = [
    { id: "31", name: "Done", to: { name: "Done" } },
    { id: "41", name: "Blocked", to: { name: "Blocked" } },
    { id: "51", name: "In Review", to: { name: "In Review" } },
  ];
  process.env.JIRA_SITE_URL = "example.atlassian.net";
  process.env.JIRA_EMAIL = "bot@example.com";
  process.env.JIRA_API_TOKEN = "token";
  delete process.env.ARTIFACT_BUCKET;

  vi.stubGlobal("fetch", async (url, options = {}) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, "");
    const method = options.method || "GET";
    h.state.calls.push(`${method} ${path}`);
    let body = {};
    if (method === "GET" && path.includes("fields=")) {
      body = { fields: { labels: h.state.labels, status: { name: h.state.status } } };
    } else if (method === "GET" && path.endsWith("/transitions")) {
      body = { transitions: h.state.transitions };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });

  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transition_ticket — human-gate decisions are not agent-writable (TEAM-4099 F3, Jira twin)", () => {
  it("agent tool path: In Review → Done on a reviewer-labelled gate is REFUSED, no Jira write", async () => {
    const res = await asAgent({ ticket_id: GATE, transition_id: "done" });

    expect(res.error).toMatch(/human-review gate/);
    expect(res.error).toMatch(/does not approve anything/);
    expect(transitionCalls()).toHaveLength(0);
  });

  it("agent tool path: 'request changes' out of In Review is refused too", async () => {
    const res = await asAgent({ ticket_id: GATE, transition_id: "blocked", reason: "self-serve rework" });
    expect(res.error).toMatch(/human-review gate/);
    expect(transitionCalls()).toHaveLength(0);
    // No comment either — the guard runs before the reason is posted.
    expect(h.state.calls.some((c) => c.includes("/comment"))).toBe(false);
  });

  it("agent tool path: `skip` (→ Done) on a gate parked in Blocked is refused", async () => {
    h.state.status = "Blocked";
    const res = await asAgent({ ticket_id: GATE, transition_id: "skip", reason: "not needed" });
    expect(res.error).toMatch(/human-review gate/);
    expect(transitionCalls()).toHaveLength(0);
  });

  it("trusted caller: the same approval lands, and costs no extra issue read", async () => {
    const res = await asTrusted({ ticket_id: GATE, transition_id: "done" });

    expect(res).toMatchObject({ ticketId: GATE, status: "done" });
    expect(transitionCalls()).toHaveLength(1);
    // The labels/status read exists only to police untrusted callers.
    expect(issueReads()).toHaveLength(0);
  });

  it("an unknown caller string is not trusted, and the marker cannot be forged from the parameters", async () => {
    const unknown = await handler({ tool_name: "Tickets___transition_ticket", _caller: "agentcore_hub_backend_dev", parameters: { ticket_id: GATE, transition_id: "done" } });
    expect(unknown.error).toMatch(/human-review gate/);

    const forged = await asAgent({ ticket_id: GATE, transition_id: "done", _caller: "console" });
    expect(forged.error).toMatch(/human-review gate/);
    expect(transitionCalls()).toHaveLength(0);
  });

  it("ordinary agent tickets are untouched: no reviewer label ⇒ the tool path still closes them", async () => {
    h.state.labels = [];
    h.state.status = "In Progress";
    const res = await asAgent({ ticket_id: DEV, transition_id: "done" });

    expect(res).toMatchObject({ ticketId: DEV, status: "done" });
    expect(transitionCalls()).toHaveLength(1);
  });

  it("the pre-existing guard still holds: a ticket with no reviewer label may never enter In Review", async () => {
    h.state.labels = [];
    h.state.status = "In Progress";
    const res = await asTrusted({ ticket_id: DEV, transition_id: "in_review" });

    expect(res.error).toMatch(/only human-review tickets/);
    expect(transitionCalls()).toHaveLength(0);
  });

  it("re-arming a gate (Blocked → In Review) is not a decision and stays open to the tool path", async () => {
    h.state.status = "Blocked";
    const res = await asAgent({ ticket_id: GATE, transition_id: "in_review" });

    expect(res).toMatchObject({ ticketId: GATE, status: "in_review" });
    expect(transitionCalls()).toHaveLength(1);
  });
});
