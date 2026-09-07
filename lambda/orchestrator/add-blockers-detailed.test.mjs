import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4185 F5 — the `addBlockers` seam's per-id token contract.
 *
 * The awaited-ids annotate gate (F3(b)) stamps preconditionUnmet only when a write
 * actually LANDED, which is only decidable if the seam can say which of the three
 * things happened per id. The historical return — an array of the ids newly added —
 * signals "already linked" AND "the write blew up" the same way: by omission. So a
 * wholly-failed write was indistinguishable from an idempotent no-op and got stamped
 * as a fresh park, manufacturing D2 evidence for an edge that does not exist.
 *
 * `opts.detailed` adds the token form ("added"/"blocked"/"preserved" | "present" |
 * "failed") WITHOUT changing the default return, because live-reverify.mjs /
 * sync-main.mjs / dead-session-escalation.mjs all read the ids back out. These pin
 * both halves of that: the default shape byte for byte, and each token the awaited-ids
 * adapter relies on, in BOTH providers (the two branches are separate code).
 *
 * index.mjs is imported for real; only its I/O seams are mocked.
 */

const h = vi.hoisted(() => ({
  state: {
    // Per-blocker DDB outcomes, consumed in order by the applyBlockerEdge mock.
    edgeOutcomes: /** @type {string[]} */ ([]),
    edgeCalls: /** @type {any[]} */ ([]),
    // Jira: which blocker ids the issueLink POST should reject for.
    jiraFailIds: /** @type {string[]} */ ([]),
    jiraCalls: /** @type {any[]} */ ([]),
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand { constructor(input) { this.input = input; } }
  class PutCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: { from: () => ({ send: async () => ({}) }) },
  };
});
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { throw new Error("NoSuchKey"); } },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

/**
 * The conditional-write decision itself is ticket-blockers.mjs's job (and is pinned
 * by ticket-blockers.test.mjs); here it is a dial, so every outcome the real module
 * can return — blocked / preserved / present / error — can be mapped to a token.
 */
vi.mock("./ticket-blockers.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    applyBlockerEdge: vi.fn(async (args) => {
      h.state.edgeCalls.push(args);
      return h.state.edgeOutcomes.shift() ?? "blocked";
    }),
  };
});

const ORIGIN = "TEAM-42";
const A = "TEAM-100";
const B = "TEAM-101";

let addBlockers;

async function load(provider) {
  if (provider === "jira") {
    process.env.TICKET_PROVIDER = "jira";
    process.env.JIRA_SITE_URL = "jira.test";
    process.env.JIRA_EMAIL = "bot@test";
    process.env.JIRA_API_TOKEN = "t";
  } else {
    delete process.env.TICKET_PROVIDER;
  }
  vi.resetModules();
  ({ addBlockers } = await import("./index.mjs"));
}

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  h.state.edgeOutcomes = [];
  h.state.edgeCalls.length = 0;
  h.state.jiraFailIds = [];
  h.state.jiraCalls.length = 0;
  global.fetch = vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    h.state.jiraCalls.push({ url: String(url), method: init.method || "GET", body });
    if (String(url).includes("/issueLink")) {
      const id = body?.inwardIssue?.key;
      if (h.state.jiraFailIds.includes(id)) {
        return { ok: false, status: 500, text: async () => "issueLink exploded" };
      }
      return { ok: true, status: 201, text: async () => "" };
    }
    // Transitions / issue reads / anything else: benign.
    return { ok: true, status: 200, text: async () => JSON.stringify({ transitions: [{ id: "1", name: "Blocked" }], fields: { status: { name: "Blocked" } } }) };
  });
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.TICKET_PROVIDER;
  delete process.env.JIRA_SITE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
});

describe("TEAM-4185 F5 — addBlockers default return is UNCHANGED (no `detailed`)", () => {
  it("dynamodb: the added-id array, with present/error ids omitted exactly as before", async () => {
    await load("dynamodb");
    h.state.edgeOutcomes = ["blocked", "present"];

    const res = await addBlockers(ORIGIN, [A, B]);

    // The historical contract every other caller reads: ids, not tokens.
    expect(res).toEqual([A]);
  });

  it("dynamodb: an errored edge is omitted too (pre-4185 behaviour, byte for byte)", async () => {
    await load("dynamodb");
    h.state.edgeOutcomes = ["error", "blocked"];

    expect(await addBlockers(ORIGIN, [A, B])).toEqual([B]);
  });

  it("jira: the added-id array, failed links omitted", async () => {
    await load("jira");
    h.state.jiraFailIds = [B];

    expect(await addBlockers(ORIGIN, [A, B])).toEqual([A]);
  });

  it("an empty/absent id list is still [] on both shapes (no seam call at all)", async () => {
    await load("dynamodb");
    expect(await addBlockers(ORIGIN, [])).toEqual([]);
    expect(await addBlockers(ORIGIN, [], { detailed: true })).toEqual([]);
    expect(await addBlockers(null, [A], { detailed: true })).toEqual([]);
    expect(h.state.edgeCalls).toHaveLength(0);
  });
});

describe("TEAM-4185 F5 — `detailed: true` returns per-id tokens", () => {
  it("dynamodb: blocked/preserved pass through as write tokens", async () => {
    await load("dynamodb");
    h.state.edgeOutcomes = ["blocked", "preserved"];

    expect(await addBlockers(ORIGIN, [A, B], { detailed: true })).toEqual(["blocked", "preserved"]);
  });

  it("dynamodb: an already-linked edge is 'present' — the idempotent no-op, NOT a failure", async () => {
    await load("dynamodb");
    h.state.edgeOutcomes = ["present"];

    expect(await addBlockers(ORIGIN, [A], { detailed: true })).toEqual(["present"]);
  });

  it("dynamodb: applyBlockerEdge 'error' becomes 'failed' — the case omission used to hide", async () => {
    await load("dynamodb");
    h.state.edgeOutcomes = ["error"];

    expect(await addBlockers(ORIGIN, [A], { detailed: true })).toEqual(["failed"]);
  });

  it("dynamodb: tokens stay POSITIONALLY aligned with the requested ids", async () => {
    await load("dynamodb");
    h.state.edgeOutcomes = ["present", "error", "blocked"];

    expect(await addBlockers(ORIGIN, [A, B, "TEAM-102"], { detailed: true }))
      .toEqual(["present", "failed", "blocked"]);
  });

  it("jira: a successful issueLink is 'added', a rejected one is 'failed'", async () => {
    await load("jira");
    h.state.jiraFailIds = [B];

    expect(await addBlockers(ORIGIN, [A, B], { detailed: true })).toEqual(["added", "failed"]);
    // Jira dedupes (type, pair), so a repeat link SUCCEEDS — a throw here is a real
    // failure, never the idempotent case, which is why there is no jira "present".
    expect(h.state.jiraCalls.filter((c) => c.url.includes("/issueLink"))).toHaveLength(2);
  });

  it("jira: an ALL-failed batch skips the Blocked transition entirely", async () => {
    await load("jira");
    h.state.jiraFailIds = [A, B];

    expect(await addBlockers(ORIGIN, [A, B], { detailed: true })).toEqual(["failed", "failed"]);
    // No edge landed, so the ticket must not be parked on a dependency it does
    // not actually have.
    expect(h.state.jiraCalls.some((c) => c.url.includes("/transitions"))).toBe(false);
  });

  it("`detailed` changes only the RETURN — the writes issued are identical", async () => {
    await load("dynamodb");
    h.state.edgeOutcomes = ["blocked", "blocked"];
    await addBlockers(ORIGIN, [A], { preserveStatusIf: ["in_progress"] });
    await addBlockers(ORIGIN, [A], { preserveStatusIf: ["in_progress"], detailed: true });

    expect(h.state.edgeCalls).toHaveLength(2);
    const [plain, detailed] = h.state.edgeCalls;
    expect(plain.ticketId).toBe(detailed.ticketId);
    expect(plain.blockerId).toBe(detailed.blockerId);
    expect(plain.table).toBe(detailed.table);
    expect(plain.preserveStatusIf).toEqual(detailed.preserveStatusIf);
    expect(detailed.preserveStatusIf).toEqual(["in_progress"]);
  });
});
