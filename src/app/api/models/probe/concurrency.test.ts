import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import seed from "@/config/models.json";
import type { ModelsRegistry, ProbeOutcome } from "@/lib/models-registry";
import { __resetModelsCaches } from "@/lib/models-registry";
import { settleDetached } from "./detached";
import { __resetProbeWriteDeps, __setProbeWriteDeps } from "./record";
import { POST } from "./route";

/**
 * TEAM-5052 — many probes finishing at once. recordOutcome() is not a route
 * export (Next forbids non-handler exports), so this drives it the way
 * production does: POST each probe with the probe itself held, release them all
 * together, and let every detached run reach recordOutcome in the same tick.
 *
 * Unlike ./route.test.ts, the S3 fake here has REAL compare-and-swap semantics:
 * a PUT whose IfMatch is not the stored ETag is a 412, exactly as S3 answers it,
 * which saveModelsRegistry turns into VersionConflictError. A writer that gives up
 * after its single retry loses its outcome, and this file counts what survived.
 */

const h = vi.hoisted(() => {
  const savedBucket = process.env.ARTIFACT_BUCKET;
  process.env.ARTIFACT_BUCKET = "test-bucket";
  const state = {
    objects: {} as Record<string, string>,
    etags: {} as Record<string, string>,
    puts: 0,
    rejected: 0,
    /** Force this many conditional PUTs to 412 regardless of the ETag. */
    forcedConflicts: 0,
    gate: null as null | Promise<void>,
    release: null as null | (() => void),
    /** Fired after each forced-412 rejection, with the 1-based rejection count
     *  so a test can install a competing writer's outcome mid-retry-loop. */
    onReject: null as null | ((n: number) => void),
    /** When set, every probe reports THIS outcome instead of `outcomeFor()`, so
     *  a second POST can finish at a different `at` than the first. */
    outcome: null as null | { ok: boolean; at: string; seconds?: number; error?: string },
  };
  return { savedBucket, state };
});

/** Yield to the event loop, so concurrent readers genuinely interleave. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      const key = cmd.input.Key as string;
      await tick();
      if (name === "GetObjectCommand") {
        const body = h.state.objects[key];
        if (body === undefined) {
          const e = new Error("no such key");
          e.name = "NoSuchKey";
          throw e;
        }
        return { Body: { transformToString: async () => body }, ETag: h.state.etags[key] };
      }
      if (name === "PutObjectCommand") {
        const forced = cmd.input.IfMatch !== undefined && h.state.forcedConflicts > 0;
        if (forced) h.state.forcedConflicts--;
        if (forced || (cmd.input.IfMatch !== undefined && cmd.input.IfMatch !== h.state.etags[key])) {
          h.state.rejected++;
          h.state.onReject?.(h.state.rejected);
          const e = new Error("At least one of the pre-conditions you specified did not hold");
          e.name = "PreconditionFailed";
          throw e;
        }
        h.state.puts++;
        h.state.objects[key] = cmd.input.Body as string;
        h.state.etags[key] = `"etag-${h.state.puts}"`;
        return { ETag: h.state.etags[key] };
      }
      throw new Error(`unexpected S3 command ${name}`);
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

/** Each probe reports an outcome that names its own row, so a lost write is visible. */
const outcomeFor = (modelId: string, mode: string): ProbeOutcome => ({
  ok: true,
  at: "2026-09-24T12:00:00Z",
  error: `${modelId}#${mode}`,
});

vi.mock("@/lib/models/probe", () => ({
  runApiProbe: async (row: { modelId: string }) => {
    if (h.state.gate) await h.state.gate;
    return h.state.outcome ?? outcomeFor(row.modelId, "api");
  },
  runCliProbe: async (row: { modelId: string }) => {
    if (h.state.gate) await h.state.gate;
    return h.state.outcome ?? outcomeFor(row.modelId, "cli");
  },
}));

const SEED = seed as unknown as ModelsRegistry;
const MODELS_KEY = "config/models.json";

/** Ten distinct probes: five routable seed rows, each probed on both planes. */
const PROBES = SEED.catalog
  .filter((r) => (r.status ?? "active") === "active" && !r.readOnly)
  .slice(0, 5)
  .flatMap((r) => (["api", "cli"] as const).map((mode) => ({ modelId: r.modelId, mode })));

function req(body: unknown): NextRequest {
  return new NextRequest("https://hub.example.com/api/models/probe", {
    method: "POST",
    headers: { "content-type": "application/json", host: "hub.example.com" },
    body: JSON.stringify(body),
  });
}

let savedAuth: string | undefined;
const sleeps: number[] = [];
const warnings = () => vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join("\n");
const liveDoc = () => JSON.parse(h.state.objects[MODELS_KEY]) as ModelsRegistry;

/** Simulates another hub instance's successful write landing mid-retry-loop:
 *  patches the row directly (bypassing our S3 fake's PUT path) and bumps the
 *  ETag, so the next GET in the loop sees it as the live document. */
function installCompetitor(modelId: string, mode: "api" | "cli", outcome: ProbeOutcome): void {
  const doc = JSON.parse(h.state.objects[MODELS_KEY]) as ModelsRegistry;
  const row = doc.catalog.find((r) => r.modelId === modelId);
  if (!row) throw new Error(`installCompetitor: no such row ${modelId}`);
  row.probe = { ...(row.probe || {}), [mode]: outcome };
  h.state.objects[MODELS_KEY] = JSON.stringify(doc);
  h.state.etags[MODELS_KEY] = '"etag-competitor"';
}

beforeEach(() => {
  const live = JSON.parse(JSON.stringify(SEED)) as ModelsRegistry;
  live.version = 5;
  h.state.objects = { [MODELS_KEY]: JSON.stringify(live) };
  h.state.etags = { [MODELS_KEY]: '"etag-live"' };
  h.state.puts = 0;
  h.state.rejected = 0;
  h.state.forcedConflicts = 0;
  h.state.onReject = null;
  h.state.outcome = null;
  sleeps.length = 0;
  savedAuth = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "none";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __resetModelsCaches();
  // The backoff is recorded, not waited out; jitter is pinned to its midpoint.
  __setProbeWriteDeps({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
});

afterEach(async () => {
  h.state.release?.();
  h.state.release = null;
  h.state.gate = null;
  await settleDetached();
  __resetProbeWriteDeps();
  if (savedAuth === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = savedAuth;
  vi.restoreAllMocks();
});

afterAll(() => {
  if (h.savedBucket === undefined) delete process.env.ARTIFACT_BUCKET;
  else process.env.ARTIFACT_BUCKET = h.savedBucket;
});

describe("POST /api/models/probe — concurrent outcomes (TEAM-5052)", () => {
  it("lands every one of 10 concurrent probe outcomes in the final document", async () => {
    expect(PROBES).toHaveLength(10);
    h.state.gate = new Promise<void>((resolve) => {
      h.state.release = resolve;
    });

    for (const p of PROBES) {
      const res = await POST(req(p));
      expect(res.status).toBe(202);
    }
    h.state.release!();
    await settleDetached();

    const doc = JSON.parse(h.state.objects[MODELS_KEY]) as ModelsRegistry;
    const landed = PROBES.filter(({ modelId, mode }) => {
      const row = doc.catalog.find((r) => r.modelId === modelId);
      return row?.probe?.[mode]?.error === `${modelId}#${mode}`;
    }).map(({ modelId, mode }) => `${modelId}#${mode}`);

    expect(landed).toEqual(PROBES.map(({ modelId, mode }) => `${modelId}#${mode}`));
    expect(doc.version).toBe(5 + PROBES.length);
  });

  it("gives up after 5 conflicts without touching S3, and logs probe.write_failed", async () => {
    const before = h.state.objects[MODELS_KEY];
    h.state.forcedConflicts = Infinity;
    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    await settleDetached();

    // Five attempts plus the one best-effort write_failed record, every one a 412.
    expect(h.state.rejected).toBe(6);
    expect(h.state.puts).toBe(0);
    expect(h.state.objects[MODELS_KEY]).toBe(before);
    expect(sleeps).toEqual([300, 300, 300, 300]);
    expect(warnings()).toContain(
      "probe.write_failed modelId=us.anthropic.claude-opus-5 mode=api attempts=5 error=version_conflict"
    );
  });

  it("records write_failed on the row when the last retry finally lands", async () => {
    h.state.forcedConflicts = 5;
    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    await settleDetached();

    expect(h.state.rejected).toBe(5);
    expect(h.state.puts).toBe(1);
    const probe = liveDoc().catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5")?.probe?.api;
    // The marker is stamped with the FAILED outcome's own `at`, not its write time (SR2-1).
    expect(probe).toEqual({ ok: false, at: "2026-09-24T12:00:00Z", error: "write_failed" });
  });

  // SR1-1: a competing hub instance can land a NEWER outcome for the same
  // model+mode while this instance is still retrying its own (older,
  // 12:00:00Z) outcome. Neither the write_failed marker nor an ordinary retry
  // may clobber it — the row must keep whichever outcome actually happened
  // later, not whichever write happens to land last.
  const COMPETITOR: ProbeOutcome = { ok: true, at: "2026-09-24T12:00:30Z", error: "competitor" };

  it("SR1-1: the write_failed marker does not clobber a newer competing outcome", async () => {
    h.state.forcedConflicts = 5;
    h.state.onReject = (n) => {
      if (n === 5) installCompetitor("us.anthropic.claude-opus-5", "api", COMPETITOR);
    };
    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    await settleDetached();

    expect(h.state.rejected).toBe(5);
    expect(h.state.puts).toBe(0);
    const probe = liveDoc().catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5")?.probe?.api;
    expect(probe).toEqual(COMPETITOR);
    expect(warnings()).toContain(
      "probe.write_failed modelId=us.anthropic.claude-opus-5 mode=api attempts=5 error=version_conflict"
    );
    expect(warnings()).toContain("probe.write_failed_superseded modelId=us.anthropic.claude-opus-5 mode=api");
  });

  it("SR1-1: an ordinary retry does not clobber a newer competing outcome", async () => {
    h.state.forcedConflicts = 1;
    h.state.onReject = (n) => {
      if (n === 1) installCompetitor("us.anthropic.claude-opus-5", "api", COMPETITOR);
    };
    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    await settleDetached();

    expect(h.state.puts).toBe(0);
    const probe = liveDoc().catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5")?.probe?.api;
    expect(probe).toEqual(COMPETITOR);
    expect(warnings()).toContain("probe.write_superseded modelId=us.anthropic.claude-opus-5 mode=api");
    expect(warnings()).not.toContain("probe.write_failed ");
  });

  it("SR1-1: an unparsable stored `at` does not block the write_failed marker", async () => {
    h.state.forcedConflicts = 5;
    h.state.onReject = (n) => {
      if (n === 5) installCompetitor("us.anthropic.claude-opus-5", "api", { ok: true, at: "not-a-date" });
    };
    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    await settleDetached();

    expect(h.state.puts).toBe(1);
    const probe = liveDoc().catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5")?.probe?.api;
    expect(probe).toMatchObject({ ok: false, error: "write_failed" });
  });

  // SR2-1 (TEAM-5150): the write_failed marker is stamped with the FAILED
  // outcome's own `at` (12:00:00Z), never the marker's write time. A probe that
  // finished LATER (12:00:30Z) but whose write lands after the marker must still
  // be recorded — with a fresh marker `at`, newerThan() would call the real
  // result stale and discard it.
  it("SR2-1: a later-finishing probe still lands over a write_failed marker", async () => {
    const LATER: ProbeOutcome = { ok: true, at: "2026-09-24T12:00:30Z", error: "later" };

    // First probe (at 12:00:00Z): five 412s, then the marker's own PUT lands.
    h.state.forcedConflicts = 5;
    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    await settleDetached();
    expect(h.state.puts).toBe(1);
    const marker = liveDoc().catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5")?.probe?.api;
    expect(marker).toEqual({ ok: false, at: "2026-09-24T12:00:00Z", error: "write_failed" });

    // Second probe finished 30s after the first; its write arrives after the marker.
    h.state.outcome = LATER;
    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    await settleDetached();

    expect(h.state.puts).toBe(2);
    const probe = liveDoc().catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5")?.probe?.api;
    expect(probe).toEqual(LATER);
    expect(warnings()).not.toContain("probe.write_superseded");
  });

  // SR3-1 (TEAM-5153): two instances finish the same model+mode probe in the
  // SAME millisecond. Strict `>` ordering let the loser's write_failed marker
  // land over the winner's real success (equal `at`, so "not newer"). A marker
  // never wins a tie against a real result; a real result never yields on one.
  const OPUS = "us.anthropic.claude-opus-5";
  const rowProbe = () => liveDoc().catalog.find((r) => r.modelId === OPUS)?.probe?.api;
  const MARKER: ProbeOutcome = { ok: false, at: "2026-09-24T12:00:00Z", error: "write_failed" };

  it("SR3-1: the write_failed marker does not clobber an equal-at real success", async () => {
    // Same instant as ours, spelled with .000Z so the tie is numeric, not string-equal.
    const EQUAL: ProbeOutcome = { ok: true, at: "2026-09-24T12:00:00.000Z", error: "competitor-equal" };
    h.state.forcedConflicts = 5;
    h.state.onReject = (n) => {
      if (n === 5) installCompetitor(OPUS, "api", EQUAL);
    };
    await POST(req({ modelId: OPUS, mode: "api" }));
    await settleDetached();

    expect(h.state.rejected).toBe(5);
    expect(h.state.puts).toBe(0);
    expect(rowProbe()).toEqual(EQUAL);
    expect(warnings()).toContain(`probe.write_failed modelId=${OPUS} mode=api attempts=5 error=version_conflict`);
    expect(warnings()).toContain(`probe.write_failed_superseded modelId=${OPUS} mode=api`);
  });

  it("SR3-1: an equal-at real result still lands over a write_failed marker", async () => {
    // First probe: five 412s, then the marker's own PUT lands.
    h.state.forcedConflicts = 5;
    await POST(req({ modelId: OPUS, mode: "api" }));
    await settleDetached();
    expect(h.state.puts).toBe(1);
    expect(rowProbe()).toEqual(MARKER);

    // Second probe finished at the SAME instant; its write arrives after the marker.
    const EQUAL: ProbeOutcome = { ok: true, at: "2026-09-24T12:00:00Z", error: "equal" };
    h.state.outcome = EQUAL;
    await POST(req({ modelId: OPUS, mode: "api" }));
    await settleDetached();

    expect(h.state.puts).toBe(2);
    expect(rowProbe()).toEqual(EQUAL);
    expect(warnings()).not.toContain("probe.write_superseded");
  });

  it("SR3-1: an equal-at marker over a stored equal-at marker leaves the marker on the row", async () => {
    h.state.forcedConflicts = 5;
    await POST(req({ modelId: OPUS, mode: "api" }));
    await settleDetached();
    expect(rowProbe()).toEqual(MARKER);

    // A second instance loses the same race at the same `at`. Whether its marker
    // PUTs again or is skipped, the row reads the same: the result was lost.
    h.state.forcedConflicts = 5;
    await POST(req({ modelId: OPUS, mode: "api" }));
    await settleDetached();

    expect(rowProbe()).toEqual(MARKER);
    expect(warnings()).not.toContain("probe.write_superseded ");
  });
});

describe("POST /api/models/probe — the live document is one the read gate refuses (TEAM-5052)", () => {
  /** The document the reconcile actually wrote: the retired row still owns the
   *  alias, and a candidate row now claims it as its id. */
  function seatRefused(): string {
    const live = JSON.parse(JSON.stringify(SEED)) as ModelsRegistry;
    live.version = 2;
    const { harnessLanes: _lanes, ...owner } = live.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-4-6")!;
    live.catalog.push({
      ...owner,
      modelId: "us.anthropic.claude-opus-4-6-v1",
      aliases: [],
      status: "candidate",
    });
    const body = JSON.stringify(live);
    h.state.objects[MODELS_KEY] = body;
    return body;
  }

  it("never overwrites the live document with the bundled seed", async () => {
    const refused = seatRefused();
    const res = await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    expect(res.status).toBe(202);
    await settleDetached();

    // Today the read falls back to BUNDLED_REGISTRY with no etag, so the probe's
    // save goes out WITHOUT IfMatch and replaces the live document wholesale.
    expect(h.state.objects[MODELS_KEY]).toBe(refused);
    expect(h.state.puts).toBe(0);
    expect(warnings()).toContain(
      "probe.write_refused modelId=us.anthropic.claude-opus-5 mode=api reason=registry_fallback source=seed"
    );
  });
});
