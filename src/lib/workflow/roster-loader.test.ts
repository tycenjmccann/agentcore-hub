import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RosterAgent } from "./roster-loader";

/**
 * TEAM-6211 — loadRoster's 15s cache must keep the LAST-GOOD live roster when a
 * refresh fails, mirroring the orchestrator's loadAgentRoster (lambda/orchestrator/
 * index.mjs), which never drops its loaded roster. Before this fix, a failed
 * refresh after the TTL returned [] — indistinguishable from "never loaded" — so
 * callers like the /complete route's livePhaseMap fell back to the bundled
 * agents.json and lost any live-only persona's phase.
 */

const h = vi.hoisted(() => ({
  state: {
    /** The next GetObject's body, or undefined to mean "throw nextError". */
    doc: undefined as string | undefined,
    nextError: null as Error | null,
    getCalls: 0,
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      h.state.getCalls++;
      if (h.state.nextError) {
        const err = h.state.nextError;
        h.state.nextError = null;
        throw err;
      }
      const body = h.state.doc;
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const ROSTER_V1: RosterAgent[] = [{ agentId: "agentcore_hub_release_captain", phase: "ship" }];
const ROSTER_V2: RosterAgent[] = [{ agentId: "agentcore_hub_release_captain", phase: "ship" }, { agentId: "agentcore_hub_qa", phase: "qa" }];

let loadRoster: typeof import("./roster-loader").loadRoster;

beforeEach(async () => {
  h.state.doc = undefined;
  h.state.nextError = null;
  h.state.getCalls = 0;
  process.env.ARTIFACT_BUCKET = "test-bucket";
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
  ({ loadRoster } = await import("./roster-loader"));
});

afterEach(() => {
  delete process.env.ARTIFACT_BUCKET;
  vi.useRealTimers();
});

describe("loadRoster — last-good roster on a failed refresh (TEAM-6211)", () => {
  it("REPRO: a failed refresh after the TTL expires returns the last-good roster, not []", async () => {
    h.state.doc = JSON.stringify({ agents: ROSTER_V1 });
    expect(await loadRoster()).toEqual(ROSTER_V1);

    vi.setSystemTime(new Date(Date.now() + 15_001));
    h.state.nextError = new Error("S3 unavailable");
    // Before the fix this returns [] — the same answer as "never loaded".
    expect(await loadRoster()).toEqual(ROSTER_V1);
  });

  it("a failed refresh re-stamps the cache so a request immediately after makes no further S3 call", async () => {
    h.state.doc = JSON.stringify({ agents: ROSTER_V1 });
    await loadRoster();

    vi.setSystemTime(new Date(Date.now() + 15_001));
    h.state.nextError = new Error("S3 unavailable");
    await loadRoster();
    const callsAfterFailure = h.state.getCalls;

    // Still within the re-stamped TTL — no new S3 GET.
    vi.setSystemTime(new Date(Date.now() + 1_000));
    expect(await loadRoster()).toEqual(ROSTER_V1);
    expect(h.state.getCalls).toBe(callsAfterFailure);

    // Past the re-stamped TTL and S3 is healthy again — picks up the new doc.
    vi.setSystemTime(new Date(Date.now() + 15_000));
    h.state.doc = JSON.stringify({ agents: ROSTER_V2 });
    expect(await loadRoster()).toEqual(ROSTER_V2);
    expect(h.state.getCalls).toBe(callsAfterFailure + 1);
  });

  it("never loaded + failure still returns [] and retries S3 on the next call", async () => {
    h.state.nextError = new Error("S3 unavailable");
    expect(await loadRoster()).toEqual([]);
    expect(h.state.getCalls).toBe(1);

    // Nothing was cached — the very next call tries S3 again immediately.
    h.state.doc = JSON.stringify({ agents: ROSTER_V1 });
    expect(await loadRoster()).toEqual(ROSTER_V1);
    expect(h.state.getCalls).toBe(2);
  });

  it("a successful empty document is cached and distinguished from a failed read", async () => {
    h.state.doc = JSON.stringify({ agents: [] });
    expect(await loadRoster()).toEqual([]);
    const callsAfterEmptyLoad = h.state.getCalls;

    // Still within the TTL — the cached empty roster, no S3 call.
    expect(await loadRoster()).toEqual([]);
    expect(h.state.getCalls).toBe(callsAfterEmptyLoad);

    // Past the TTL, a failed refresh keeps the empty roster rather than
    // inventing agents or treating it as "never loaded".
    vi.setSystemTime(new Date(Date.now() + 15_001));
    h.state.nextError = new Error("S3 unavailable");
    expect(await loadRoster()).toEqual([]);
  });

  it("no ARTIFACT_BUCKET → [] with zero S3 calls", async () => {
    delete process.env.ARTIFACT_BUCKET;
    vi.resetModules();
    ({ loadRoster } = await import("./roster-loader"));
    expect(await loadRoster()).toEqual([]);
    expect(h.state.getCalls).toBe(0);
  });
});
