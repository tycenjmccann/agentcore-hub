import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { provesTransitioned, rejectedDetails, jiraStatusToInternal, jiraDisplayNameOf, HUB_STATUSES } from "./ticket-transition-refusal";
import { JIRA_DONE_SUCCESS, JIRA_NAME_MATCH_CLOSED } from "./__fixtures__/ticket-transition-success";

/**
 * TEAM-6131 Finding 4 — the cross-codebase contract between the REAL jira ticket-tools
 * Lambda's Tickets___transition_ticket success return and the hub's provesTransitioned,
 * driven end to end with a fake Jira.
 *
 * The Lambda matches a requested transition by NAME or by destination
 * (lambda/agentcore-hub-jira/index.mjs transitionTicket) and reports the destination's
 * internal status. A team-managed workflow whose transition named "Done" lands in a
 * status the hub does not model ("Closed") therefore answers `status:"closed"` for a
 * requested "done"; the validator required status === target and both console routes
 * answered 502 for a ticket that had moved — and every retry refused ("No transition to
 * Done"). The Lambda now also reports `requested` and the `matchedTransition`, and the
 * validator accepts that pair only when the landed status is not one of the hub's own
 * other columns.
 *
 * Hermetic: the real handler is imported with its Jira REST behind a fake fetch that
 * serves exactly the four requests a reason-less Done makes; ARTIFACT_BUCKET is unset
 * so the roster, the completion-record gate and the Done-intent fence make no S3 call
 * (an S3 call is a test failure). Same harness shape as
 * lambda/workflow-output/done-race-e2e.test.mjs and lambda/orchestrator/self-park-claim-chain.test.mjs.
 *
 * The fixtures in __fixtures__/ticket-transition-success.ts are pinned here with toEqual,
 * so the route tests that answer with them cannot drift from what the Lambda returns.
 */

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { constructor: { name: string } }) {
      throw new Error(`S3 must not be called on this path (${cmd.constructor.name})`);
    }
  },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  PutObjectCommand: class { constructor(public input: unknown) {} },
}));

type Handler = (event: { tool_name: string; parameters: Record<string, unknown> }) => Promise<Record<string, unknown>>;

const TICKET = "TEAM-7";
const SITE = "jira.test";
const ISSUE = `https://${SITE}/rest/api/3/issue/${TICKET}`;
const ENV_KEYS = ["JIRA_SITE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY", "ARTIFACT_BUCKET", "WORKFLOWS_TABLE", "EVENTS_TABLE", "PIPELINE_TOOLS_LAMBDA"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

/** A fake Jira Cloud whose transition list is `transitions`; records every transition POST body. */
function installFakeJira(transitions: Array<{ id: string; name: string; to: { name: string } }>) {
  const posts: unknown[] = [];
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    if (method === "GET" && u === `${ISSUE}?fields=status`) return json({ key: TICKET, fields: { status: { name: "In Progress" } } });
    if (method === "GET" && u === `${ISSUE}?fields=labels,description`) return json({ key: TICKET, fields: { labels: [], description: null } });
    if (method === "GET" && u === `${ISSUE}/transitions`) return json({ transitions });
    if (method === "POST" && u === `${ISSUE}/transitions`) {
      posts.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected Jira ${method} ${u}`);
  });
  return posts;
}

type JiraModule = { handler: Handler; mapStatusToInternal: (name: unknown) => string };

async function loadJira(): Promise<JiraModule> {
  vi.resetModules();
  return (await import("../../../lambda/agentcore-hub-jira/index.mjs")) as JiraModule;
}

async function loadHandler(): Promise<Handler> {
  return (await loadJira()).handler;
}

const transitionDone = (handler: Handler) =>
  handler({ tool_name: "Tickets___transition_ticket", parameters: { ticket_id: TICKET, transition_id: "done" } });

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.JIRA_SITE_URL = SITE;
  process.env.JIRA_EMAIL = "bot@test";
  process.env.JIRA_API_TOKEN = "t";
  process.env.JIRA_PROJECT_KEY = "TEAM";
  // Module-load constants in the Lambda: with none of these, the roster, the
  // completion-record gate, the Done-intent fence and the claim fence are inert.
  delete process.env.ARTIFACT_BUCKET;
  delete process.env.WORKFLOWS_TABLE;
  delete process.env.EVENTS_TABLE;
  delete process.env.PIPELINE_TOOLS_LAMBDA;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the REAL jira Lambda's transition_ticket return × provesTransitioned (TEAM-6131 F4)", () => {
  it('a transition NAMED "Done" whose destination is "Closed": the Lambda reports what it did, and it is proof of done', async () => {
    const posts = installFakeJira([{ id: "31", name: "Done", to: { name: "Closed" } }]);
    const handler = await loadHandler();

    const res = await transitionDone(handler);

    // The move happened — exactly one POST of the matched transition.
    expect(posts).toEqual([{ transition: { id: "31" } }]);
    // The contract, byte for byte: status is where Jira landed, requested + matchedTransition
    // say what was asked for and which transition answered it. (Pins the shared fixture.)
    expect(res).toEqual(JIRA_NAME_MATCH_CLOSED);
    // The literal the runtime harness's park gate keys on (deploy/runtime-agent/main.py _ParkGate).
    expect(res.message).toBe("Transitioned to closed");

    expect(provesTransitioned(res, "done", TICKET)).toBe(true);
    expect(provesTransitioned(res, "done", "TEAM-8")).toBe(false);
    expect(provesTransitioned(res, "blocked", TICKET)).toBe(false);
  });

  it("the same return with an arbitrary landed status (one of the hub's own columns) is NOT proof", async () => {
    installFakeJira([{ id: "31", name: "Done", to: { name: "Closed" } }]);
    const handler = await loadHandler();
    const res = await transitionDone(handler);

    expect(provesTransitioned({ ...res, status: "in_progress" }, "done", TICKET)).toBe(false);
    expect(provesTransitioned({ ...res, status: "blocked" }, "done", TICKET)).toBe(false);
  });

  it("the ordinary Done (destination IS Done) still returns the pinned shape and is proof", async () => {
    const posts = installFakeJira([{ id: "31", name: "Done", to: { name: "Done" } }]);
    const handler = await loadHandler();

    const res = await transitionDone(handler);

    expect(posts).toEqual([{ transition: { id: "31" } }]);
    expect(res).toEqual(JIRA_DONE_SUCCESS);
    expect(provesTransitioned(res, "done", TICKET)).toBe(true);
  });

  it("a transition matched by DESTINATION (name differs) reports the destination and is proof", async () => {
    installFakeJira([{ id: "41", name: "Resolve it", to: { name: "Done" } }]);
    const handler = await loadHandler();

    const res = await transitionDone(handler);

    expect(res).toEqual({ ...JIRA_DONE_SUCCESS, matchedTransition: { id: "41", name: "Resolve it", to: "Done" } });
    expect(provesTransitioned(res, "done", TICKET)).toBe(true);
  });
});

/**
 * TEAM-6141 — the validator now mirrors the Lambda's status map (mapStatusToInternal) and
 * its match rule (name or destination equals the target's Jira display name). These pin
 * the mirror against the REAL Lambda module, and show that the fail-open shape (c) — a
 * transition NAMED for something else — is one the Lambda never emits for a requested done.
 */
describe("the TS status-map mirror × the REAL jira Lambda's mapStatusToInternal (TEAM-6141)", () => {
  // Every Jira display name the mirror knows (via each hub status), the cancelled spellings,
  // and a few names the hub does NOT model — the generic lowercase + underscore rule.
  const NAMES: unknown[] = [
    ...HUB_STATUSES.map((s) => jiraDisplayNameOf(s)),
    "To Do", "Ready", "In Progress", "In Review", "Blocked", "Done", "Won't Do",
    "WONT DO", "wont do", "Cancelled", "Canceled",
    "Closed", "Resolved", "Waiting for review", "Ready for QA",
    "  In Progress ", "DONE", "", null, undefined,
  ];

  it.each(NAMES.map((n) => [n]))("jiraStatusToInternal(%j) === mapStatusToInternal(%j)", async (name) => {
    const { mapStatusToInternal } = await loadJira();
    expect(jiraStatusToInternal(name)).toBe(mapStatusToInternal(name));
  });

  it("every hub status round-trips through its Jira display name in BOTH implementations", async () => {
    const { mapStatusToInternal } = await loadJira();
    for (const s of HUB_STATUSES) {
      const display = jiraDisplayNameOf(s);
      expect(display, `no Jira display name for ${s}`).not.toBe("");
      expect(mapStatusToInternal(display)).toBe(s);
      expect(jiraStatusToInternal(display)).toBe(s);
    }
  });

  it('(c) a workflow offering only "Start Review → Waiting for review" REFUSES a requested done — the Lambda never emits that pair', async () => {
    const posts = installFakeJira([{ id: "51", name: "Start Review", to: { name: "Waiting for review" } }]);
    const handler = await loadHandler();

    // The handler answers a refusal as `{ error }` inside a 200 payload (index.mjs handler
    // catch) — the shape rejectedDetails reads — and POSTs nothing.
    const res = await transitionDone(handler);
    expect(res).toEqual({ error: 'No transition to "Done" found. Available: Start Review (-> Waiting for review)' });
    expect(rejectedDetails(res, "done")).toMatch(/No transition to "Done" found/);
    expect(provesTransitioned(res, "done", TICKET)).toBe(false);
    expect(posts).toEqual([]);
    // …so the validator refusing that shape costs nothing real.
    expect(
      provesTransitioned(
        { ticketId: TICKET, status: "waiting_for_review", requested: "done", matchedTransition: { id: "51", name: "Start Review", to: "Waiting for review" } },
        "done",
        TICKET
      )
    ).toBe(false);
  });
});
