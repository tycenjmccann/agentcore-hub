import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Routine } from "@/lib/routines/types";

/**
 * TEAM-5016 finding 6 — POST /api/routines validates `input.modelOverride`.
 *
 * The defect: the route persisted `input` verbatim, so an override the workflow
 * front door refuses (a typo, a retired id, a read-only row) was stored and the
 * routine then failed on every fire — the runner records `lastRun.failed` and
 * returns 200 on a 4xx, so nothing ever retried and nobody was asked to fix it.
 *
 * Contract under test: an unusable override is the SAME 400 the workflow route
 * sends, BEFORE the schedule or the record is written; a usable one is stored
 * NORMALIZED to the id that will really be invoked; an empty one is dropped.
 * ARTIFACT_BUCKET stays unset, so the registry is the bundled seed.
 */
const h = vi.hoisted(() => ({
  puts: [] as Routine[],
  schedules: [] as string[],
}));

vi.mock("@/lib/routines/store", () => ({
  listRoutines: vi.fn(async () => []),
  putRoutine: vi.fn(async (r: Routine) => {
    h.puts.push(r);
  }),
}));
vi.mock("@/lib/routines/schedule", () => ({
  upsertSchedule: vi.fn(async (id: string) => {
    h.schedules.push(id);
    return `arn:aws:scheduler:us-east-1:000000000000:schedule/default/${id}`;
  }),
}));
vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async (id: string) => (id === "routine-weekly-report" ? { id } : null)),
}));
vi.mock("@/lib/workflow/roster-loader", () => ({
  boundConnectorIdsForDef: vi.fn(async () => new Set<string>()),
}));

let POST: typeof import("./route").POST;
let savedBucket: string | undefined;

beforeEach(async () => {
  h.puts.length = 0;
  h.schedules.length = 0;
  savedBucket = process.env.ARTIFACT_BUCKET;
  delete process.env.ARTIFACT_BUCKET;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  if (savedBucket === undefined) delete process.env.ARTIFACT_BUCKET;
  else process.env.ARTIFACT_BUCKET = savedBucket;
  vi.restoreAllMocks();
});

function req(input: Record<string, unknown>): NextRequest {
  return new NextRequest("https://hub.example.com/api/routines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Weekly report",
      workflowDefId: "routine-weekly-report",
      schedule: { expression: "rate(7 days)" },
      input: { titleTemplate: "Weekly report {date}", description: "x", workflowDefId: "routine-weekly-report", ...input },
    }),
  });
}

describe("POST /api/routines — modelOverride", () => {
  it("400s an override the workflow front door would refuse, before writing anything", async () => {
    const cases: Array<[string, string]> = [
      ["clade-opus-5", "unknown_model"],
      ["us.anthropic.claude-opus-4-8", "inactive"],
      ["anthropic.claude-opus-5", "read_only"],
    ];
    for (const [modelOverride, reason] of cases) {
      const res = await POST(req({ modelOverride }));
      expect(res.status, modelOverride).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_model_override", reason, modelOverride });
    }
    expect(h.puts).toEqual([]);
    expect(h.schedules).toEqual([]);
  });

  it("stores a usable override normalized to the catalog id", async () => {
    const res = await POST(req({ modelOverride: "claude-sonnet-5" }));
    expect(res.status).toBe(201);
    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].input.modelOverride).toBe("us.anthropic.claude-sonnet-5");
    expect((await res.json()).routine.input.modelOverride).toBe("us.anthropic.claude-sonnet-5");
    expect(h.schedules).toEqual([h.puts[0].routineId]);
  });

  it("drops an empty override rather than storing an empty string", async () => {
    const res = await POST(req({ modelOverride: "" }));
    expect(res.status).toBe(201);
    expect("modelOverride" in h.puts[0].input).toBe(false);
  });

  it("leaves a routine with no override untouched", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(201);
    expect("modelOverride" in h.puts[0].input).toBe(false);
  });
});
