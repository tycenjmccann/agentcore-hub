import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Routine } from "@/lib/routines/types";

/**
 * TEAM-5016 finding 6 — PATCH /api/routines/[id] validates an edited
 * `input.modelOverride` the same way create does (see ../route.test.ts), and
 * `null` clears a stored one — the spread merge alone could never remove a key.
 */
const h = vi.hoisted(() => ({
  routine: null as Routine | null,
  mutations: 0,
}));

vi.mock("@/lib/routines/store", () => ({
  getOwnedRoutine: vi.fn(async () => h.routine),
  mutateRoutine: vi.fn(async (_id: string, fn: (r: Routine) => Routine) => {
    h.mutations += 1;
    if (!h.routine) return null;
    h.routine = fn(h.routine);
    return h.routine;
  }),
  deleteRoutine: vi.fn(async () => {}),
}));
vi.mock("@/lib/routines/schedule", () => ({
  upsertSchedule: vi.fn(async (id: string) => `arn:aws:scheduler:us-east-1:000000000000:schedule/default/${id}`),
  deleteSchedule: vi.fn(async () => {}),
}));
vi.mock("@/lib/workflow/defs-loader", () => ({
  resolveWorkflowDef: vi.fn(async (id: string) => ({ id })),
}));

let PATCH: typeof import("./route").PATCH;
let savedBucket: string | undefined;

function seatRoutine(input: Partial<Routine["input"]> = {}): void {
  h.routine = {
    routineId: "rt-1",
    tenantId: "default",
    name: "Weekly report",
    workflowDefId: "routine-weekly-report",
    schedule: { expression: "rate(7 days)", timezone: "UTC" },
    input: { titleTemplate: "Weekly report {date}", description: "x", workflowDefId: "routine-weekly-report", ...input },
    enabled: true,
    createdBy: "default",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

beforeEach(async () => {
  h.mutations = 0;
  seatRoutine();
  savedBucket = process.env.ARTIFACT_BUCKET;
  delete process.env.ARTIFACT_BUCKET;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.resetModules();
  ({ PATCH } = await import("./route"));
});

afterEach(() => {
  if (savedBucket === undefined) delete process.env.ARTIFACT_BUCKET;
  else process.env.ARTIFACT_BUCKET = savedBucket;
  vi.restoreAllMocks();
});

function patch(body: unknown) {
  const req = new NextRequest("https://hub.example.com/api/routines/rt-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ id: "rt-1" }) });
}

describe("PATCH /api/routines/[id] — modelOverride", () => {
  it("400s an override the workflow front door would refuse, and mutates nothing", async () => {
    const res = await patch({ input: { modelOverride: "anthropic.claude-opus-5" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_model_override",
      reason: "read_only",
      modelOverride: "anthropic.claude-opus-5",
    });
    expect(h.mutations).toBe(0);
  });

  it("stores an edited override normalized to the catalog id", async () => {
    const res = await patch({ input: { modelOverride: "claude-sonnet-5" } });
    expect(res.status).toBe(200);
    expect((await res.json()).routine.input.modelOverride).toBe("us.anthropic.claude-sonnet-5");
    expect(h.routine!.input.modelOverride).toBe("us.anthropic.claude-sonnet-5");
  });

  it("clears a stored override on null, which a spread merge alone could not do", async () => {
    seatRoutine({ modelOverride: "us.anthropic.claude-opus-5" });
    const res = await patch({ input: { modelOverride: null } });
    expect(res.status).toBe(200);
    expect("modelOverride" in h.routine!.input).toBe(false);
    // The rest of the input template survived the merge.
    expect(h.routine!.input.titleTemplate).toBe("Weekly report {date}");
  });

  it("does not touch the override when the edit is about something else", async () => {
    seatRoutine({ modelOverride: "us.anthropic.claude-opus-5" });
    const res = await patch({ name: "Renamed", input: { description: "new brief" } });
    expect(res.status).toBe(200);
    expect(h.routine!.input.modelOverride).toBe("us.anthropic.claude-opus-5");
    expect(h.routine!.input.description).toBe("new brief");
  });
});
