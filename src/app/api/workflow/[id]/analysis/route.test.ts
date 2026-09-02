import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-3758 / AC-D2.5 — old ANALYSIS record deserialize/render back-compat.
 *
 * TEAM-3747 D2 folded the ship-blocked terminal outcomes (deploy-blocked /
 * static-ci-only) into RunOutcome (analysis-types.ts) and into save_analysis.py's
 * RUN_OUTCOMES. QA (TEAM-3750) found the WORKFLOW-record half of AC-D2.5 covered
 * at four layers, but the ANALYSIS-record half was not: no test loaded a legacy
 * analysis row LACKING `runOutcome` (pre-D2 shape) through the real read path.
 *
 * This drives the REAL GET /api/workflow/[id]/analysis handler — the only code
 * that deserializes stored analysis records — with the DynamoDB doc client
 * stubbed (the same stub-client seam workflow-store.test.mjs uses). It pins two
 * directions of AC-D2.5:
 *   1. a legacy record with no `runOutcome` deserializes without error and the
 *      route invents nothing — `runOutcome` stays `undefined` end to end (latest,
 *      history, and the trend projection), exactly as it read before D2; and
 *   2. a new-shape record carrying a ship-blocked `runOutcome` flows through the
 *      same path unchanged.
 *
 * The route is a pass-through cast (Items → WorkflowAnalysis[]) with no schema
 * validation, so "deserialize" here means: the handler reads, projects, and
 * responds 200 over the legacy shape without throwing or defaulting the outcome.
 */

const ANALYSES_TABLE = "agentcore-hub-workflow-analyses";

const h = vi.hoisted(() => {
  const state: {
    // Rows returned for the run query (KeyConditionExpression on workflowId).
    analyses: Array<Record<string, unknown>>;
    // Rows returned for the def-level trend query (workflowDefId-index GSI).
    trendRows: Array<Record<string, unknown>>;
    // The workflows-table row for the workflowDefId fallback GetCommand.
    workflowItem: Record<string, unknown> | null;
    // Force the ANALYSES query to fail with ResourceNotFoundException (pre-deploy).
    tableMissing: boolean;
  } = { analyses: [], trendRows: [], workflowItem: null, tableMissing: false };
  return { state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class QueryCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    QueryCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const name = cmd.constructor.name;
          if (name === "QueryCommand") {
            // The def-level trend query is the only one that rides the GSI.
            if (cmd.input.IndexName) return { Items: h.state.trendRows };
            if (h.state.tableMissing) {
              const e = new Error("Requested resource not found");
              e.name = "ResourceNotFoundException";
              throw e;
            }
            return { Items: h.state.analyses };
          }
          if (name === "GetCommand") return { Item: h.state.workflowItem };
          return {};
        },
      }),
    },
  };
});

let GET: (req: NextRequest, ctx: { params: { id: string } }) => Promise<Response>;

beforeEach(async () => {
  vi.clearAllMocks();
  h.state.analyses = [];
  h.state.trendRows = [];
  h.state.workflowItem = null;
  h.state.tableMissing = false;
  process.env.ANALYSES_TABLE = ANALYSES_TABLE;
  vi.resetModules();
  ({ GET } = await import("./route"));
});

const call = (id = "wf_1") =>
  GET(new NextRequest(`http://localhost/api/workflow/${id}/analysis`), { params: { id } });

// The metrics block the trend projection reads (?? null everywhere else).
const metrics = () => ({
  startedAt: "2026-07-01T10:00:00Z",
  completedAt: "2026-07-01T12:00:00Z",
  totalDurationMs: 7_200_000,
  phases: [],
  agentTasks: [],
  humanReviews: [],
  humanWaitTotalMs: 0,
  changeRequests: { count: 0, cycles: [] },
  fixTickets: { count: 0, ticketIds: [] },
  nudgeCount: 0,
  managerInterventions: [],
  errors: [],
  tokens: null,
  evalSummaries: [],
  counts: { tickets: 3, events: 8, artifacts: 0, completions: 1 },
  dataQuality: { ticketProvider: "dynamodb", missingSignals: [], notes: [] },
});

/**
 * A pre-D2 analysis row: the full record MINUS `runOutcome`. Nothing in
 * production back-filled that field onto rows written before TEAM-3747 D2, so
 * this is the shape a real legacy row still has in DynamoDB.
 */
const legacyAnalysis = (analysisId: string) => ({
  workflowId: "wf_1",
  analysisId,
  schemaVersion: 1,
  workflowDefId: "software-delivery",
  epicId: null,
  analyzedAt: "2026-07-01T12:05:00Z",
  trigger: "auto",
  // runOutcome deliberately absent.
  model: "us.anthropic.claude-opus-4-8",
  s3Prefix: "workflows/wf_1/analysis/" + analysisId + "/",
  metrics: metrics(),
  scores: { overall: 82, planning: 80, execution: 85, reviewEfficiency: 78, reworkDiscipline: 90 },
  verdict: "Solid run.",
  findings: [{ title: "Worked", kind: "success", severity: "low", evidence: "e" }],
  recommendations: [],
  trend: { priorRunsCompared: 0, deltas: {}, notes: "" },
  summaryMarkdown: "# Report\n" + "x".repeat(220),
});

const newShapeAnalysis = (analysisId: string, runOutcome: string) => ({
  ...legacyAnalysis(analysisId),
  analysisId,
  runOutcome,
});

describe("AC-D2.5 — a legacy analysis record (no runOutcome) deserializes and reads unchanged", () => {
  it("responds 200 and passes the record through without inventing runOutcome", async () => {
    h.state.analyses = [legacyAnalysis("t2"), legacyAnalysis("t1")];
    h.state.trendRows = [legacyAnalysis("t2")];

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();

    // latest + history carry the legacy shape intact...
    expect(body.latest.analysisId).toBe("t2");
    expect(body.history).toHaveLength(2);
    // ...and the missing outcome is NOT defaulted to "complete" (or anything).
    expect("runOutcome" in body.latest).toBe(false);
    expect(body.latest.runOutcome).toBeUndefined();
  });

  it("the trend projection emits runOutcome as undefined for a legacy row (no default)", async () => {
    h.state.analyses = [legacyAnalysis("t1")];
    h.state.trendRows = [legacyAnalysis("t1")];

    const body = await (await call()).json();
    expect(body.trend).toHaveLength(1);
    // Every other trend field defaults with `?? null`; runOutcome is read raw,
    // so a legacy row surfaces `undefined` — the pre-D2 reading, no invention.
    expect(body.trend[0].runOutcome).toBeUndefined();
    expect(body.trend[0].overallScore).toBe(82);
    expect(body.trend[0].totalDurationMs).toBe(7_200_000);
  });

  it("resolves the def via the workflows-table fallback when the latest row lacks it", async () => {
    // A legacy row with neither runOutcome NOR workflowDefId still resolves the
    // trend def from the run record — the GetCommand fallback path.
    const { workflowDefId: _drop, ...noDef } = legacyAnalysis("t1");
    h.state.analyses = [noDef];
    h.state.workflowItem = { workflowDefId: "software-delivery" };
    h.state.trendRows = [legacyAnalysis("t1")];

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trend).toHaveLength(1);
  });
});

describe("AC-D2.5 — a new-shape ship-blocked analysis record flows through the same path", () => {
  it.each(["deploy-blocked", "static-ci-only", "complete", "cancelled", "error"])(
    "carries runOutcome %s through latest and the trend projection",
    async (outcome) => {
      h.state.analyses = [newShapeAnalysis("t1", outcome)];
      h.state.trendRows = [newShapeAnalysis("t1", outcome)];

      const body = await (await call()).json();
      expect(body.latest.runOutcome).toBe(outcome);
      expect(body.trend[0].runOutcome).toBe(outcome);
    }
  );
});

describe("AC-D2.5 — an empty / pre-deploy analyses table is not an error", () => {
  it("returns empty latest/history/trend on ResourceNotFoundException", async () => {
    h.state.tableMissing = true;
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ latest: null, history: [], trend: [] });
  });
});
