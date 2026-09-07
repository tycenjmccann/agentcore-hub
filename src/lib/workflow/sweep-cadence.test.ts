import { describe, it, expect } from "vitest";
import {
  normalizeSweepCadenceMode,
  sweepRepoKey,
  evaluateSweepCadence,
  findOpenSweepPr,
  evaluateSweepGate,
  skipTombstoneId,
  buildSkipTombstone,
  SWEEP_CADENCE_DAYS,
} from "./sweep-cadence";
import type { SweepWorkflowRow } from "./sweep-cadence";

/**
 * TEAM-4247 D2 — the pure half of the sweep cadence gate. The wiring (Scan, PR
 * probe, tombstone write, 200 response) is covered by
 * src/app/api/workflow/start/route.cadence.test.ts; this file pins the decisions.
 */

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const REPO = "tycenjmccann/ember";

function row(ageDays: number, over: Partial<SweepWorkflowRow> = {}): SweepWorkflowRow {
  const at = new Date(NOW - ageDays * DAY).toISOString();
  return {
    workflowId: `wf_${ageDays}`,
    workflowDefId: "dead-code-sweep",
    phase: "complete",
    startedAt: at,
    completedAt: at,
    input: { repoConfig: { layout: "monorepo", repos: [{ url: `https://github.com/${REPO}` }] } },
    ...over,
  } as SweepWorkflowRow;
}

describe("normalizeSweepCadenceMode", () => {
  it("unset → shadow (observe a new install before it refuses scheduled work)", () => {
    expect(normalizeSweepCadenceMode(undefined)).toBe("shadow");
    expect(normalizeSweepCadenceMode("")).toBe("shadow");
    expect(normalizeSweepCadenceMode("  ")).toBe("shadow");
  });

  it("garbage → off (a typo must never silently start skipping runs)", () => {
    expect(normalizeSweepCadenceMode("enforced")).toBe("off");
    expect(normalizeSweepCadenceMode("true")).toBe("off");
    expect(normalizeSweepCadenceMode(1)).toBe("off");
  });

  it("accepts the three modes case- and space-insensitively", () => {
    expect(normalizeSweepCadenceMode("ENFORCE")).toBe("enforce");
    expect(normalizeSweepCadenceMode(" shadow ")).toBe("shadow");
    expect(normalizeSweepCadenceMode("off")).toBe("off");
  });
});

describe("sweepRepoKey", () => {
  it("normalizes url spellings to one owner/name key", () => {
    expect(sweepRepoKey({ layout: "monorepo", repos: [{ url: "https://github.com/Tycenj/Ember.git" }] } as never)).toBe(
      "tycenj/ember"
    );
    expect(sweepRepoKey({ layout: "monorepo", repos: [{ url: "git@github.com:tycenj/ember" }] } as never)).toBe(
      "tycenj/ember"
    );
  });

  it("is empty when there is no parseable GitHub repo — the caller must skip the gate", () => {
    expect(sweepRepoKey(undefined)).toBe("");
    expect(sweepRepoKey({ layout: "multi-repo", repos: [] } as never)).toBe("");
    expect(sweepRepoKey({ layout: "monorepo", repos: [{ url: "https://gitlab.com/x/y" }] } as never)).toBe("");
  });
});

describe("evaluateSweepCadence", () => {
  it("skips inside the window and runs outside it", () => {
    expect(evaluateSweepCadence({ repo: REPO, rows: [row(3)], now: NOW })?.skip).toBe("recent-sweep");
    expect(evaluateSweepCadence({ repo: REPO, rows: [row(21)], now: NOW })).toBeNull();
    // The boundary: exactly minIntervalDays old is old enough.
    expect(evaluateSweepCadence({ repo: REPO, rows: [row(SWEEP_CADENCE_DAYS)], now: NOW })).toBeNull();
  });

  it("reports the newest run as the evidence", () => {
    const d = evaluateSweepCadence({ repo: REPO, rows: [row(30), row(2), row(9)], now: NOW });
    expect(d?.evidence).toMatchObject({ repo: REPO, lastRunId: "wf_2", minIntervalDays: 14, runsConsidered: 3 });
    expect(d?.evidence.ageDays).toBeCloseTo(2, 1);
  });

  it("counts a still-RUNNING sweep — the strongest reason not to start another", () => {
    const running = row(1, { workflowId: "wf_live", phase: "development", completedAt: undefined });
    expect(evaluateSweepCadence({ repo: REPO, rows: [running], now: NOW })?.evidence.lastRunId).toBe("wf_live");
  });

  it("counts a nothing-to-remove sweep (it did happen; it just found nothing)", () => {
    expect(
      evaluateSweepCadence({ repo: REPO, rows: [row(4, { phase: "nothing-to-remove" })], now: NOW })?.skip
    ).toBe("recent-sweep");
  });

  it("ignores this gate's own tombstones, deleted rows, other repos and other defs", () => {
    const rows = [
      row(1, { workflowId: "wf_tomb", type: "skipped" }),
      row(1, { workflowId: "wf_del", deleted: true }),
      row(1, { workflowId: "wf_other_def", workflowDefId: "software-delivery" }),
      row(1, {
        workflowId: "wf_other_repo",
        input: {
          repoConfig: {
            layout: "monorepo",
            repos: [{ url: "https://github.com/other/repo", defaultBranch: "main", platform: "backend" }],
          },
        },
      }),
    ];
    const d = evaluateSweepCadence({ repo: REPO, rows, now: NOW });
    expect(d).toBeNull();
  });

  it("ignores unusable and future timestamps — an unaged row cannot justify a skip", () => {
    const rows = [
      row(1, { workflowId: "wf_bad", startedAt: "not-a-date", completedAt: undefined }),
      row(-5, { workflowId: "wf_future" }),
    ];
    expect(evaluateSweepCadence({ repo: REPO, rows, now: NOW })).toBeNull();
  });

  it("does nothing without a repo key (every repo-less run would look like one repo)", () => {
    expect(evaluateSweepCadence({ repo: "", rows: [row(1)], now: NOW })).toBeNull();
  });
});

describe("findOpenSweepPr", () => {
  const pr = (over: Record<string, unknown>) => ({ number: 7, url: "u", headRef: "", title: "", labels: [], ...over });

  it("matches on head branch, title or label", () => {
    expect(findOpenSweepPr([pr({ headRef: "feature/TEAM-1-dead-code-sweep" })], { repo: REPO })?.skip).toBe(
      "open-sweep-pr"
    );
    expect(findOpenSweepPr([pr({ title: "Remove dead code from utils" })], { repo: REPO })?.skip).toBe("open-sweep-pr");
    expect(findOpenSweepPr([pr({ labels: ["sweep"] })], { repo: REPO })?.skip).toBe("open-sweep-pr");
  });

  it("counts a draft sweep PR — unreviewed work in flight either way", () => {
    expect(findOpenSweepPr([pr({ title: "Dead code sweep", draft: true })], { repo: REPO })).not.toBeNull();
  });

  it("ignores unrelated PRs and an empty list", () => {
    expect(findOpenSweepPr([pr({ title: "Bump deps", headRef: "chore/deps" })], { repo: REPO })).toBeNull();
    expect(findOpenSweepPr([], { repo: REPO })).toBeNull();
    expect(findOpenSweepPr(undefined, { repo: REPO })).toBeNull();
  });

  it("returns the PR as evidence", () => {
    const d = findOpenSweepPr([pr({ number: 56, url: "https://x/56", headRef: "feature/x-sweep" })], { repo: REPO });
    expect(d?.evidence).toEqual({ repo: REPO, pr: 56, url: "https://x/56", headRef: "feature/x-sweep", title: "" });
  });
});

describe("evaluateSweepGate", () => {
  const sweepPr = { number: 56, url: "u", headRef: "feature/x-dead-code-sweep", title: "sweep", labels: [] };

  it("cadence wins over the probe (one DDB read decides before any network claim)", () => {
    const d = evaluateSweepGate({ repo: REPO, rows: [row(3)], pulls: [sweepPr], prProbe: { probed: true }, now: NOW });
    expect(d.skip).toBe("recent-sweep");
  });

  it("falls through to the open PR when the cadence is satisfied", () => {
    const d = evaluateSweepGate({ repo: REPO, rows: [row(30)], pulls: [sweepPr], prProbe: { probed: true }, now: NOW });
    expect(d.skip).toBe("open-sweep-pr");
  });

  it("never skips on an UNPROBED PR list — the probe fails open", () => {
    const d = evaluateSweepGate({
      repo: REPO,
      rows: [row(30)],
      pulls: [sweepPr],
      prProbe: { probed: false, reason: "no GITHUB_PAT — PR probe skipped" },
      now: NOW,
    });
    expect(d.skip).toBeNull();
    expect(d.evidence.prProbe).toMatchObject({ probed: false });
  });

  it("carries the cadence evidence on a run it lets through (what shadow reads)", () => {
    const d = evaluateSweepGate({ repo: REPO, rows: [row(30)], prProbe: { probed: true }, pulls: [], now: NOW });
    expect(d.skip).toBeNull();
    expect(d.evidence).toMatchObject({ repo: REPO, lastRunId: "wf_30", minIntervalDays: 14, runsConsidered: 1 });
    expect((d.evidence as { ageDays: number }).ageDays).toBeCloseTo(30, 1);
  });

  it("reports empty evidence on a repo that was never swept", () => {
    const d = evaluateSweepGate({ repo: REPO, rows: [], prProbe: { probed: true }, pulls: [], now: NOW });
    expect(d.skip).toBeNull();
    expect(d.evidence).toMatchObject({ repo: REPO, lastRunId: null, lastRunAt: null, runsConsidered: 0 });
  });
});

describe("skipTombstoneId / buildSkipTombstone", () => {
  it("is deterministic per (repo, day) and changes the next day", () => {
    const a = skipTombstoneId(REPO, "2026-09-07T00:01:00.000Z");
    const b = skipTombstoneId(REPO, "2026-09-07T23:59:00.000Z");
    expect(a).toBe("skip_tycenjmccann-ember_20260907");
    expect(b).toBe(a);
    expect(skipTombstoneId(REPO, "2026-09-08T00:00:00.000Z")).toBe("skip_tycenjmccann-ember_20260908");
  });

  it("builds the amendment-2 tombstone shape", () => {
    const evidence = { repo: REPO, pr: 56, url: "u", headRef: "h", title: "t" };
    const t = buildSkipTombstone({ repo: REPO, reason: "open-sweep-pr", evidence, at: NOW, trigger: "scheduled" });
    expect(t).toMatchObject({
      workflowId: "skip_tycenjmccann-ember_20260907",
      type: "skipped",
      reason: "open-sweep-pr",
      evidence,
      repo: REPO,
      defId: "dead-code-sweep",
      workflowDefId: "dead-code-sweep",
      at: new Date(NOW).toISOString(),
      // Load-bearing: `deleted` keeps the row out of the workflow list and out of
      // cost-report's terminal scan; `cancelled` keeps every sweep/watchdog off it.
      deleted: true,
      phase: "cancelled",
      skipReason: "sweep-cadence",
      trigger: "scheduled",
    });
  });
});
