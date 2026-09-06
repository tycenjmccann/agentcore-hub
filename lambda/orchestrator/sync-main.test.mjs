import { describe, it, expect, vi } from "vitest";
import { syncBeforeCi, normalizeSyncMode } from "./sync-main.mjs";
import { validateFixContract, sanitizeSpawnedBy } from "./fix-contract.mjs";

/**
 * sync-main.mjs (TEAM-4122 FR-6) — the pre-CI "merge the default branch into the
 * integration branch" step. Fully DI'd, so every branch runs with no AWS and no
 * network: `deps` is plain objects plus a recording fake GitHub keyed by
 * `"<METHOD> <path>"`.
 *
 * What this file is actually protecting:
 *
 *  1. The F9 direction pin. `base` is the run's feature branch and `head` is the
 *     default branch, ALWAYS. A reversed pair would be a push to main, so the
 *     refusals (no featureBranch / base === head / `-advisory` / no PAT / no
 *     repo) are asserted as ZERO GitHub calls and zero store+ticket calls, not
 *     merely as a return value — a "skipped" that still POSTed would pass a
 *     return-value-only test.
 *  2. Path encoding. Owner, repo and both refs are interpolated into URLs, so the
 *     assertions are on the RECORDED paths with a space and a slash in each
 *     segment.
 *  3. Idempotency. The claim does NOT serialize the conflict path (we release the
 *     claim there on purpose), so the same CI ticket can arrive twice against the
 *     same default-branch head. Twice must mean one merge and ONE fix ticket.
 *  4. Fail-open. 404/422/500/network/`publishEvent` throwing/`setSyncMain`
 *     throwing all leave CI dispatchable, because certifying an un-synced head
 *     (the pre-FR-6 behaviour) beats not certifying at all. Only `conflict`
 *     stops a dispatch.
 *  5. The fix ticket is REALLY valid: the contract object sent to create_ticket
 *     is fed through the same validateFixContract + sanitizeSpawnedBy the tickets
 *     Lambda runs, so a contract that enforce mode would reject cannot ship.
 */

const OWNER = "acme";
const REPO = "juno";
const BASE = "feature/TEAM-1-thing";
const HEAD = "main";
const CI = "TEAM-9";
const EPIC = "TEAM-1";
const WF = "wf_1";
const MAIN_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERGE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIX_ID = "TEAM-500";

// Mirrors the module's own path building (owner/repo are encodeURIComponent'd
// too), so a route key and a real call line up byte for byte.
const rp = (owner = OWNER, repo = REPO) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const branchesPath = (head = HEAD, owner = OWNER, repo = REPO) =>
  `${rp(owner, repo)}/branches/${encodeURIComponent(head)}`;
const comparePath = (a, b, owner = OWNER, repo = REPO) =>
  `${rp(owner, repo)}/compare/${encodeURIComponent(a)}...${encodeURIComponent(b)}`;
const mergesPath = (owner = OWNER, repo = REPO) => `${rp(owner, repo)}/merges`;

/**
 * Recording fake GitHub. `routes` maps `"<METHOD> <path>"` → `{status, body}` or
 * a function returning one (or throwing, for a network error).
 *
 * Two seams come out of ONE route table on purpose:
 *   `raw` is index.mjs's githubRequestRaw — never throws on a status;
 *   `api` is index.mjs's githubApi — returns the body, THROWS with `.status` on
 *   a non-2xx.
 * So the same scenario can be replayed with and without the raw seam, which is
 * how the 201-vs-204 and thrown-409 paths are both exercised.
 */
function gh(routes = {}) {
  const calls = [];
  const raw = vi.fn(async (path, method = "GET", body = null) => {
    calls.push({ key: `${method} ${path}`, path, method, body });
    const route = routes[`${method} ${path}`];
    if (route === undefined) {
      const err = new Error(`unrouted ${method} ${path}`);
      err.status = 404;
      throw err;
    }
    return typeof route === "function" ? await route() : route;
  });
  const api = vi.fn(async (path, method = "GET", body = null) => {
    const res = await raw(path, method, body);
    if (res.status >= 200 && res.status < 300) return res.body;
    const err = new Error(`GitHub ${method} ${path} ${res.status}`);
    err.status = res.status;
    throw err;
  });
  return { raw, api, calls, keys: () => calls.map((c) => c.key) };
}

function makeDeps(routes, over = {}) {
  const g = gh(routes);
  const events = [];
  const deps = {
    githubApi: g.api,
    githubApiRaw: g.raw,
    store: { setSyncMain: vi.fn(async () => {}), setTaskStatus: vi.fn(async () => {}) },
    invokeTickets: vi.fn(async () => ({ key: FIX_ID })),
    addBlockers: vi.fn(async () => {}),
    publishEvent: vi.fn(async (ticketId, type, detail) => { events.push({ ticketId, type, detail }); }),
    getAgentDef: (id) => ({ agentId: id, phase: AGENT_PHASES[id] }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    mode: "enforce",
    log: { warn: () => {} },
    ...over,
  };
  return { deps, gh: g, events, event: (type) => events.filter((e) => e.type === type) };
}

/** Only what these fixtures need — getAgentDef is a seam, not the real roster. */
const AGENT_PHASES = {
  agentcore_hub_backend_dev: "development",
  agentcore_hub_frontend_dev: "development",
  agentcore_hub_bug_fixer: "development",
  agentcore_hub_qa_verifier: "verification",
  agentcore_hub_ci_agent: "review",
};

function makeWorkflow(over = {}) {
  return {
    id: WF,
    epicId: EPIC,
    featureBranch: BASE,
    repoConfig: { repos: [{ url: `https://github.com/${OWNER}/${REPO}.git`, defaultBranch: HEAD }] },
    agentTasks: {},
    ...over,
  };
}
const ciTicket = () => ({ ticketId: CI, assignee: "agentcore_hub_ci_agent" });

/** Nothing was written anywhere — the shape every refusal must have. */
function expectNoWrites(deps, g) {
  expect(g.calls).toEqual([]);
  expect(deps.invokeTickets).not.toHaveBeenCalled();
  expect(deps.addBlockers).not.toHaveBeenCalled();
  expect(deps.store.setSyncMain).not.toHaveBeenCalled();
  expect(deps.store.setTaskStatus).not.toHaveBeenCalled();
}

// ─── normalizeSyncMode ───────────────────────────────────────────────────────

describe("normalizeSyncMode — strict allow-list, garbage → off", () => {
  it("accepts the three modes, trimmed and case-folded", () => {
    expect(normalizeSyncMode("enforce")).toBe("enforce");
    expect(normalizeSyncMode("shadow")).toBe("shadow");
    expect(normalizeSyncMode("off")).toBe("off");
    expect(normalizeSyncMode(" Enforce ")).toBe("enforce");
    expect(normalizeSyncMode("SHADOW")).toBe("shadow");
  });

  it("coalesces everything else to off — this flag PUSHES A COMMIT, so a typo must never arm it", () => {
    // "on"/"1"/"true" are the legacy truthies other flags honour. NOT here: the
    // blast radius of a mis-read value is a merge commit on a shared branch.
    for (const v of ["on", "1", "true", "yes", "enfroce", "shadwo", "", "  ", "0", "false", null, undefined, 7, {}, []]) {
      expect(normalizeSyncMode(v)).toBe("off");
    }
  });
});

// ─── F9 refusals ─────────────────────────────────────────────────────────────

describe("F9 refusals — nothing is touched before base/head are proven safe", () => {
  it("no featureBranch → no_feature_branch, zero calls", async () => {
    const { deps, gh: g } = makeDeps({});
    const r = await syncBeforeCi(makeWorkflow({ featureBranch: undefined }), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "skipped", reason: "no_feature_branch" });
    expectNoWrites(deps, g);
  });

  it("featureBranch === the default branch → base_equals_head (this would be main→main)", async () => {
    const { deps, gh: g } = makeDeps({});
    const r = await syncBeforeCi(makeWorkflow({ featureBranch: "main" }), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "skipped", reason: "base_equals_head" });
    expectNoWrites(deps, g);
  });

  it("an -advisory branch is never written to", async () => {
    const { deps, gh: g } = makeDeps({});
    const r = await syncBeforeCi(makeWorkflow({ featureBranch: "feature/TEAM-1-advisory" }), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "skipped", reason: "advisory_branch" });
    expectNoWrites(deps, g);
  });

  it("no githubApi (no PAT on the install) → no_pat, and NOT even an event", async () => {
    const { deps, gh: g } = makeDeps({}, { githubApi: undefined, githubApiRaw: undefined });
    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "skipped", reason: "no_pat" });
    expect(deps.publishEvent).not.toHaveBeenCalled(); // install-wide config, not run news
    expectNoWrites(deps, g);
  });

  it("repos: [] → no_repo", async () => {
    const { deps, gh: g } = makeDeps({});
    const r = await syncBeforeCi(makeWorkflow({ repoConfig: { repos: [] } }), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "skipped", reason: "no_repo" });
    expectNoWrites(deps, g);
  });

  it("a ref with a path traversal is refused rather than encoded", async () => {
    const { deps, gh: g } = makeDeps({});
    const r = await syncBeforeCi(makeWorkflow({ featureBranch: "feature/../../main" }), ciTicket(), deps);
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toBe("no_feature_branch"); // failed safeRef, so it never became a base
    expectNoWrites(deps, g);
  });

  it("mode off is a no-op even when everything else is valid", async () => {
    const { deps, gh: g } = makeDeps({}, { mode: "off" });
    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "skipped", reason: "mode_off" });
    expectNoWrites(deps, g);
  });
});

// ─── URL encoding ────────────────────────────────────────────────────────────

describe("URL encoding — every interpolated segment is percent-encoded", () => {
  it("owner 'ty cen', repo 'a-b', head 'release/1.x', base 'feature/x-y'", async () => {
    // The owner/repo regex stops at `/` and `.`, so the hostile-ish pair that can
    // really reach these paths is a spaced owner + a slashed/dotted REF.
    const owner = "ty cen";
    const repo = "a-b";
    const head = "release/1.x";
    const base = "feature/x-y";
    const { deps, gh: g } = makeDeps({
      [`GET ${branchesPath(head, owner, repo)}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
      [`POST ${mergesPath(owner, repo)}`]: { status: 201, body: { sha: MERGE_SHA } },
    });
    const wf = makeWorkflow({
      featureBranch: base,
      repoConfig: { repos: [{ url: `https://github.com/${owner}/${repo}.git`, defaultBranch: head }] },
    });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r.outcome).toBe("synced");
    expect(g.keys()).toEqual([
      `GET /repos/ty%20cen/a-b/branches/release%2F1.x`,
      `POST /repos/ty%20cen/a-b/merges`,
    ]);
    // Raw (unencoded) segments must not appear anywhere in a path.
    for (const { path } of g.calls) {
      expect(path).not.toContain("ty cen");
      expect(path).not.toContain("release/1.x");
      expect(path).not.toContain(" ");
    }
    // The BODY carries the real ref names — encoding is a URL concern only.
    expect(g.calls[1].body).toMatchObject({ base, head });
  });

  it("shadow's compare path encodes both refs around a literal '...'", async () => {
    const { deps, gh: g } = makeDeps(
      {
        [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
        [`GET ${comparePath(BASE, HEAD)}`]: { status: 200, body: { ahead_by: 3, status: "behind" } },
      },
      { mode: "shadow" }
    );
    await syncBeforeCi(makeWorkflow(), ciTicket(), deps);
    expect(g.keys()).toContain(`GET /repos/acme/juno/compare/feature%2FTEAM-1-thing...main`);
  });
});

// ─── idempotency ─────────────────────────────────────────────────────────────

describe("idempotency against the default-branch head", () => {
  const routes = () => ({
    [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
    [`POST ${mergesPath()}`]: { status: 201, body: { sha: MERGE_SHA } },
  });

  it("same ciTicketId + same baseHeadSha + status synced → already_synced, ONLY the branches GET happened", async () => {
    const { deps, gh: g } = makeDeps(routes());
    const wf = makeWorkflow({ syncMain: { ciTicketId: CI, baseHeadSha: MAIN_SHA, status: "synced" } });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "skipped", reason: "already_synced", baseHeadSha: MAIN_SHA });
    expect(g.keys()).toEqual([`GET ${branchesPath()}`]);
    expect(deps.store.setSyncMain).not.toHaveBeenCalled();
    expect(deps.publishEvent).not.toHaveBeenCalled(); // a redelivery is not news
  });

  it("status noop counts as already-synced too", async () => {
    const { deps, gh: g } = makeDeps(routes());
    const wf = makeWorkflow({ syncMain: { ciTicketId: CI, baseHeadSha: MAIN_SHA, status: "noop" } });
    expect((await syncBeforeCi(wf, ciTicket(), deps)).reason).toBe("already_synced");
    expect(g.keys()).toEqual([`GET ${branchesPath()}`]);
  });

  it("main MOVED (different baseHeadSha) → syncs again", async () => {
    const { deps } = makeDeps(routes());
    const wf = makeWorkflow({ syncMain: { ciTicketId: CI, baseHeadSha: "0".repeat(40), status: "synced" } });
    expect((await syncBeforeCi(wf, ciTicket(), deps)).outcome).toBe("synced");
  });

  it("a DIFFERENT CI ticket on the same run syncs on its own account", async () => {
    const { deps } = makeDeps(routes());
    const wf = makeWorkflow({ syncMain: { ciTicketId: "TEAM-OTHER", baseHeadSha: MAIN_SHA, status: "synced" } });
    expect((await syncBeforeCi(wf, ciTicket(), deps)).outcome).toBe("synced");
  });

  it("a prior conflict with NO fixTicketId retries the merge (nothing is blocking CI yet)", async () => {
    const { deps } = makeDeps(routes());
    const wf = makeWorkflow({ syncMain: { ciTicketId: CI, baseHeadSha: MAIN_SHA, status: "conflict", fixTicketId: null } });
    expect((await syncBeforeCi(wf, ciTicket(), deps)).outcome).toBe("synced");
  });

  it("a prior conflict WITH a fix ticket: the merge is RE-ATTEMPTED and, once it lands, CI is freed", async () => {
    const { deps } = makeDeps(routes()); // POST /merges now 201 — the dev resolved it
    const wf = makeWorkflow({
      syncMain: { ciTicketId: CI, baseHeadSha: MAIN_SHA, status: "conflict", fixTicketId: FIX_ID, files: ["b.ts"] },
    });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    // Short-circuiting on the recorded conflict would wedge the run forever: the
    // ONLY unblock is the dev resolving it and CI re-dispatching against the very
    // same main head.
    expect(r).toMatchObject({ outcome: "synced", sha: MERGE_SHA });
    expect(deps.invokeTickets).not.toHaveBeenCalled();
  });

  it("…and while it still conflicts, no SECOND ticket is filed — the recorded one is reused", async () => {
    const { deps, gh: g, event } = makeDeps({
      [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
      [`POST ${mergesPath()}`]: { status: 409, body: { message: "Merge conflict" } },
    });
    const wf = makeWorkflow({
      syncMain: { ciTicketId: CI, baseHeadSha: MAIN_SHA, status: "conflict", fixTicketId: FIX_ID, files: ["b.ts"] },
      agentTasks: { [CI]: { agentId: "agentcore_hub_ci_agent", status: "running" } },
    });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "conflict", fixTicketId: FIX_ID, reason: "already_ticketed", files: ["b.ts"] });
    expect(deps.invokeTickets).not.toHaveBeenCalled();
    // The persisted file list is reused, so the two compares are not paid again.
    expect(g.keys()).toEqual([`GET ${branchesPath()}`, `POST ${mergesPath()}`]);
    expect(event("workflow.sync_conflict")[0].detail).toMatchObject({ fixTicketId: FIX_ID, alreadyTicketed: true });
    // The blocker + claim release are re-applied; both are idempotent, and
    // re-running them repairs a first pass that filed the ticket then failed to block.
    expect(deps.addBlockers).toHaveBeenCalledTimes(1);
    expect(deps.addBlockers).toHaveBeenCalledWith(CI, [FIX_ID]);
    expect(deps.store.setTaskStatus).toHaveBeenCalledTimes(1);
    expect(deps.store.setTaskStatus).toHaveBeenCalledWith(WF, CI, "ready");
    expect(wf.agentTasks[CI].status).toBe("ready");
  });

  it("branches GET throws → fail open (skipped + sync_skipped), and NO merge is attempted", async () => {
    const { deps, gh: g, event } = makeDeps({
      [`GET ${branchesPath()}`]: () => { const e = new Error("boom"); e.status = 500; throw e; },
      [`POST ${mergesPath()}`]: { status: 201, body: { sha: MERGE_SHA } },
    });

    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "skipped", reason: "base_head_unavailable", status: 500 });
    expect(g.keys()).toEqual([`GET ${branchesPath()}`]);
    expect(event("workflow.sync_skipped")).toHaveLength(1);
    expect(deps.store.setSyncMain).not.toHaveBeenCalled();
  });

  it("a branches response with no commit.sha is also base_head_unavailable — no sha, no idempotency key", async () => {
    const { deps } = makeDeps({ [`GET ${branchesPath()}`]: { status: 200, body: {} } });
    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "skipped", reason: "base_head_unavailable" });
  });
});

// ─── shadow ──────────────────────────────────────────────────────────────────

describe("shadow — one read, one event, ZERO writes", () => {
  async function runShadow(aheadBy, status = "behind") {
    const ctx = makeDeps(
      {
        [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
        [`GET ${comparePath(BASE, HEAD)}`]: { status: 200, body: { ahead_by: aheadBy, status } },
      },
      { mode: "shadow" }
    );
    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), ctx.deps);
    return { ...ctx, r };
  }

  it("behind by 4 → dry_run{behindBy:4, wouldSync:true, conflictKnown:false, shadow:true}", async () => {
    const { r, deps, gh: g, event } = await runShadow(4);

    expect(r).toMatchObject({ outcome: "dry-run", baseHeadSha: MAIN_SHA, reason: "would_sync" });
    const [ev] = event("workflow.sync_dry_run");
    expect(ev.ticketId).toBe(CI);
    expect(ev.detail).toMatchObject({
      workflowId: WF, ticketId: CI, base: BASE, head: HEAD, baseHeadSha: MAIN_SHA,
      behindBy: 4, compareStatus: "behind", wouldSync: true,
      // A compare cannot answer "would it conflict" — only a merge can. Never
      // let a quiet shadow rollout be read as "no conflicts here".
      conflictKnown: false, shadow: true,
    });

    expect(g.keys()).toEqual([`GET ${branchesPath()}`, `GET ${comparePath(BASE, HEAD)}`]);
    expect(g.calls.every((c) => c.method === "GET")).toBe(true);
    expect(deps.store.setSyncMain).not.toHaveBeenCalled();
    expect(deps.store.setTaskStatus).not.toHaveBeenCalled();
    expect(deps.invokeTickets).not.toHaveBeenCalled();
    expect(deps.addBlockers).not.toHaveBeenCalled();
  });

  it("ahead_by 0 (already level with main) → wouldSync false, outcome still dry-run", async () => {
    const { r, event } = await runShadow(0, "identical");
    expect(r).toMatchObject({ outcome: "dry-run", reason: "up_to_date" });
    expect(event("workflow.sync_dry_run")[0].detail).toMatchObject({ behindBy: 0, wouldSync: false });
  });

  it("a missing ahead_by is 0, not NaN", async () => {
    const ctx = makeDeps(
      {
        [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
        [`GET ${comparePath(BASE, HEAD)}`]: { status: 200, body: {} },
      },
      { mode: "shadow" }
    );
    await syncBeforeCi(makeWorkflow(), ciTicket(), ctx.deps);
    expect(ctx.event("workflow.sync_dry_run")[0].detail.behindBy).toBe(0);
  });

  it("compare unavailable → skipped, still no writes", async () => {
    const ctx = makeDeps(
      {
        [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
        [`GET ${comparePath(BASE, HEAD)}`]: { status: 404, body: { message: "Not Found" } },
      },
      { mode: "shadow" }
    );
    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), ctx.deps);
    expect(r).toMatchObject({ outcome: "skipped", reason: "compare_unavailable", status: 404 });
    expect(ctx.event("workflow.sync_skipped")).toHaveLength(1);
    expect(ctx.deps.store.setSyncMain).not.toHaveBeenCalled();
  });
});

// ─── enforce: 201 / 204 ──────────────────────────────────────────────────────

describe("enforce — 201 synced / 204 noop", () => {
  it("201: the POST body is exactly {base, head, commit_message}, and the merge is recorded", async () => {
    const { deps, gh: g, event } = makeDeps({
      [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
      [`POST ${mergesPath()}`]: { status: 201, body: { sha: MERGE_SHA } },
    });
    const wf = makeWorkflow();

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "synced", sha: MERGE_SHA, baseHeadSha: MAIN_SHA });

    const post = g.calls.find((c) => c.method === "POST");
    expect(Object.keys(post.body).sort()).toEqual(["base", "commit_message", "head"]);
    expect(post.body.base).toBe(BASE);   // F9: base is the FEATURE branch
    expect(post.body.head).toBe(HEAD);   // F9: head is the DEFAULT branch
    expect(post.body.commit_message).toContain(HEAD);
    expect(post.body.commit_message).toContain(BASE);
    expect(post.body.commit_message).toContain(CI);

    const [ev] = event("workflow.branch_synced");
    expect(ev.detail).toMatchObject({
      workflowId: WF, ticketId: CI, base: BASE, head: HEAD, sha: MERGE_SHA, baseHeadSha: MAIN_SHA, noop: false,
    });

    expect(deps.store.setSyncMain).toHaveBeenCalledTimes(1);
    const [wfId, rec] = deps.store.setSyncMain.mock.calls[0];
    expect(wfId).toBe(WF);
    expect(rec).toMatchObject({ status: "synced", sha: MERGE_SHA, baseHeadSha: MAIN_SHA, ciTicketId: CI });
    // The in-memory snapshot is updated too, so the SAME container's next read
    // (and the idempotency check above) sees it without a DynamoDB round trip.
    expect(wf.syncMain).toMatchObject({ status: "synced", baseHeadSha: MAIN_SHA });
    expect(deps.invokeTickets).not.toHaveBeenCalled();
  });

  it("204 (already up to date): noop, no sha of our own, status noop", async () => {
    const { deps, event } = makeDeps({
      [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
      [`POST ${mergesPath()}`]: { status: 204, body: null },
    });

    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "noop", sha: null, baseHeadSha: MAIN_SHA });
    expect(event("workflow.branch_synced")[0].detail).toMatchObject({ noop: true, sha: null });
    expect(deps.store.setSyncMain.mock.calls[0][1]).toMatchObject({ status: "noop" });
  });

  it("without the raw seam, githubApi's body shape still separates 201 from 204", async () => {
    // No githubApiRaw injected — index.mjs omits it when there is no PAT-backed
    // raw helper, and the fallback reads "a body means a merge commit".
    const mk = (mergeBody) => {
      const ctx = makeDeps(
        {
          [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
          [`POST ${mergesPath()}`]: { status: 200, body: mergeBody },
        },
        { githubApiRaw: undefined }
      );
      return ctx;
    };
    const withCommit = mk({ sha: MERGE_SHA });
    expect(await syncBeforeCi(makeWorkflow(), ciTicket(), withCommit.deps)).toMatchObject({ outcome: "synced", sha: MERGE_SHA });
    const empty = mk(null);
    expect(await syncBeforeCi(makeWorkflow(), ciTicket(), empty.deps)).toMatchObject({ outcome: "noop" });
  });
});

// ─── enforce: 409 conflict ───────────────────────────────────────────────────

describe("enforce — 409 conflict files ONE sync_fix ticket and holds CI", () => {
  const BASE_HEAD_FILES = ["a.ts", "b.ts", "c.ts"]; // base...head
  const HEAD_BASE_FILES = ["b.ts", "c.ts", "d.ts"]; // head...base
  const CANDIDATES = ["b.ts", "c.ts"];              // changed on BOTH sides

  function conflictRoutes({ mergeStatus = 409, files = true } = {}) {
    const r = {
      [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
      [`POST ${mergesPath()}`]: { status: mergeStatus, body: { message: "Merge conflict" } },
    };
    if (files) {
      r[`GET ${comparePath(BASE, HEAD)}`] = { status: 200, body: { files: BASE_HEAD_FILES.map((filename) => ({ filename })) } };
      r[`GET ${comparePath(HEAD, BASE)}`] = { status: 200, body: { files: HEAD_BASE_FILES.map((filename) => ({ filename })) } };
    }
    return r;
  }

  /** Dev tasks: the LATEST-completed development-phase agent owns the conflict. */
  const devTasks = {
    "T-1": { agentId: "agentcore_hub_backend_dev", completedAt: "2026-09-06T10:00:00.000Z", ticketId: "T-1" },
    "T-2": { agentId: "agentcore_hub_frontend_dev", completedAt: "2026-09-06T11:00:00.000Z", ticketId: "T-2" },
    // A LATER completion, but verification phase — must not win the assignment.
    "T-3": { agentId: "agentcore_hub_qa_verifier", completedAt: "2026-09-06T12:00:00.000Z", ticketId: "T-3" },
    [CI]: { agentId: "agentcore_hub_ci_agent", status: "running" },
  };

  it("raw seam reports 409 as a status: one ticket, blocker, claim released, events, persisted", async () => {
    const { deps, event } = makeDeps(conflictRoutes());
    const wf = makeWorkflow({ agentTasks: { ...devTasks } });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "conflict", fixTicketId: FIX_ID, baseHeadSha: MAIN_SHA, files: CANDIDATES });

    // ── the ticket ──
    expect(deps.invokeTickets).toHaveBeenCalledTimes(1);
    const [op, params] = deps.invokeTickets.mock.calls[0];
    expect(op).toBe("create_ticket");
    expect(params.summary).toBe(`Fix (sync-main): merge conflict with ${HEAD} in 2 file(s)`);
    expect(params.spawned_by).toEqual({ kind: "sync_fix", ciTicketId: CI });
    expect(params.phase).toBe("development");
    expect(params.blocked_by).toEqual([]);
    expect(params.parent_key).toBe(EPIC);
    expect(params.workflow_id).toBe(WF);
    // Latest-completed DEVELOPMENT agent, not the later QA one.
    expect(params.assignee).toBe("agentcore_hub_frontend_dev");
    expect(params.fix_contract).toMatchObject({
      evidence_source: "static",
      cited_location: ["b.ts:1", "c.ts:1"],
      sibling_scope: "conflict resolution only",
    });
    expect(params.fix_contract.invariant).toContain(HEAD);
    expect(params.fix_contract.invariant).toContain(BASE);
    // The description must give the dev the actual resolution recipe.
    expect(params.description).toContain(`git merge origin/${HEAD}`);
    expect(params.description).toContain(CI);
    for (const f of CANDIDATES) expect(params.description).toContain(f);

    // ── the hold ──
    expect(deps.addBlockers).toHaveBeenCalledTimes(1);
    expect(deps.addBlockers).toHaveBeenCalledWith(CI, [FIX_ID]);
    expect(deps.store.setTaskStatus).toHaveBeenCalledTimes(1);
    expect(deps.store.setTaskStatus).toHaveBeenCalledWith(WF, CI, "ready");
    expect(wf.agentTasks[CI].status).toBe("ready");

    // ── the record ──
    expect(event("workflow.sync_conflict")[0].detail).toMatchObject({
      workflowId: WF, ticketId: CI, fixTicketId: FIX_ID, files: CANDIDATES, base: BASE, head: HEAD,
    });
    expect(event("workflow.branch_synced")).toHaveLength(0);
    expect(deps.store.setSyncMain.mock.calls.at(-1)[1]).toMatchObject({
      status: "conflict", fixTicketId: FIX_ID, ciTicketId: CI, baseHeadSha: MAIN_SHA, files: CANDIDATES,
    });
  });

  it("githubApi-only seam: a THROWN error with .status === 409 takes the identical path", async () => {
    const { deps } = makeDeps(conflictRoutes(), { githubApiRaw: undefined });
    const wf = makeWorkflow({ agentTasks: { ...devTasks } });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "conflict", fixTicketId: FIX_ID, files: CANDIDATES });
    expect(deps.invokeTickets).toHaveBeenCalledTimes(1);
    expect(deps.invokeTickets.mock.calls[0][1].summary).toBe(`Fix (sync-main): merge conflict with ${HEAD} in 2 file(s)`);
  });

  it("the fix_contract sent PASSES the tickets Lambda's own validateFixContract", async () => {
    const { deps } = makeDeps(conflictRoutes());
    await syncBeforeCi(makeWorkflow({ agentTasks: { ...devTasks } }), ciTicket(), deps);
    const params = deps.invokeTickets.mock.calls[0][1];

    // Reproduce what lambda/agentcore-hub-tickets/index.mjs does at create time:
    // sanitizeSpawnedBy(spawned_by) → validateFixContract({spawnedBy, ...fix_contract}).
    const spawn = sanitizeSpawnedBy(params.spawned_by);
    expect(spawn.value).toMatchObject({ kind: "sync_fix", ciTicketId: CI });

    const fc = validateFixContract({ spawnedBy: spawn.value, ...params.fix_contract });
    // ok:true is the whole point — under FIX_TICKET_CONTRACT=enforce anything
    // else means the tickets Lambda mints NOTHING and the conflict is silent.
    expect(fc).toMatchObject({ ok: true, missing: [], invalid: [] });
    // F11: `evidence_repro` is shape-checked even for `static`, so it must stay a
    // single command — no `&&`, no `;`, no backticks, no newline.
    expect(fc.contract.evidenceRepro).toBe(`git merge origin/${HEAD}`);
    expect(fc.contract.evidenceSource).toBe("static");
  });

  it("no development-phase task on the run → falls back to the backend dev, never unassigned", async () => {
    const { deps } = makeDeps(conflictRoutes());
    const wf = makeWorkflow({
      agentTasks: {
        "T-3": { agentId: "agentcore_hub_qa_verifier", completedAt: "2026-09-06T12:00:00.000Z" },
        "T-4": { agentId: "agentcore_hub_backend_dev" }, // still running: no completedAt
      },
    });
    await syncBeforeCi(wf, ciTicket(), deps);
    // Unassigned would never dispatch, which would strand the run.
    expect(deps.invokeTickets.mock.calls[0][1].assignee).toBe("agentcore_hub_backend_dev");
  });

  it("compare unavailable → 'unknown files' in the title, empty cited_location, ticket still filed", async () => {
    const { deps } = makeDeps(conflictRoutes({ files: false })); // both compares unrouted → throw
    const wf = makeWorkflow({ agentTasks: { ...devTasks } });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "conflict", fixTicketId: FIX_ID, files: [] });
    const params = deps.invokeTickets.mock.calls[0][1];
    expect(params.summary).toBe(`Fix (sync-main): merge conflict with ${HEAD} in unknown files`);
    expect(params.fix_contract.cited_location).toEqual([]);
    expect(params.description).toContain("git merge");
  });

  it("a path with a space or a colon is dropped from cited_location, not allowed to invalidate it", async () => {
    const bad = ["src/a b.ts", "src/c:d.ts", "src/ok.ts"];
    const { deps } = makeDeps({
      [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
      [`POST ${mergesPath()}`]: { status: 409, body: { message: "Merge conflict" } },
      [`GET ${comparePath(BASE, HEAD)}`]: { status: 200, body: { files: bad.map((filename) => ({ filename })) } },
      [`GET ${comparePath(HEAD, BASE)}`]: { status: 200, body: { files: bad.map((filename) => ({ filename })) } },
    });

    await syncBeforeCi(makeWorkflow({ agentTasks: { ...devTasks } }), ciTicket(), deps);
    const params = deps.invokeTickets.mock.calls[0][1];

    expect(params.fix_contract.cited_location).toEqual(["src/ok.ts:1"]);
    // …but the dropped paths are still NAMED in the description, so no
    // information is lost — only the machine-readable anchor is conservative.
    expect(params.description).toContain("src/a b.ts");
    // And the whole contract still validates.
    const fc = validateFixContract({ spawnedBy: sanitizeSpawnedBy(params.spawned_by).value, ...params.fix_contract });
    expect(fc.ok).toBe(true);
  });

  it("more than 300 files on a side → the description says the list is truncated and points at git merge", async () => {
    const many = Array.from({ length: 320 }, (_, i) => ({ filename: `src/f${i}.ts` }));
    const { deps } = makeDeps({
      [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
      [`POST ${mergesPath()}`]: { status: 409, body: { message: "Merge conflict" } },
      [`GET ${comparePath(BASE, HEAD)}`]: { status: 200, body: { files: many } },
      [`GET ${comparePath(HEAD, BASE)}`]: { status: 200, body: { files: many } },
    });

    await syncBeforeCi(makeWorkflow({ agentTasks: { ...devTasks } }), ciTicket(), deps);
    const params = deps.invokeTickets.mock.calls[0][1];

    expect(params.description).toContain("truncated");
    expect(params.description).toContain("git merge");
    // cited_location stays readable even with a 320-file drift.
    expect(params.fix_contract.cited_location.length).toBeLessThanOrEqual(20);
  });

  it("create_ticket throws → conflict_unticketed, CI is NOT held, nothing is blocked", async () => {
    const { deps, event } = makeDeps(conflictRoutes(), {
      invokeTickets: vi.fn(async () => { throw new Error("tickets lambda down"); }),
    });

    const r = await syncBeforeCi(makeWorkflow({ agentTasks: { ...devTasks } }), ciTicket(), deps);

    // Fail OPEN: with no ticket there is nothing to block on and nobody assigned,
    // so holding CI would strand the run. CI dispatches against the un-synced
    // head (pre-FR-6 behaviour) and the event is the record.
    expect(r).toMatchObject({ outcome: "skipped", reason: "conflict_unticketed", files: CANDIDATES });
    expect(deps.addBlockers).not.toHaveBeenCalled();
    expect(deps.store.setTaskStatus).not.toHaveBeenCalled();
    expect(event("workflow.sync_conflict")).toHaveLength(0);
    expect(event("workflow.sync_skipped")).toHaveLength(1);
    expect(deps.store.setSyncMain.mock.calls.at(-1)[1]).toMatchObject({ status: "conflict", fixTicketId: null });
  });

  it("create_ticket answering without a key is the same as failing", async () => {
    const { deps } = makeDeps(conflictRoutes(), { invokeTickets: vi.fn(async () => ({ error: "nope" })) });
    const r = await syncBeforeCi(makeWorkflow({ agentTasks: { ...devTasks } }), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "skipped", reason: "conflict_unticketed" });
  });
});

// ─── other merge failures ────────────────────────────────────────────────────

// ─── TEAM-4131 F1 ────────────────────────────────────────────────────────────

describe("TEAM-4131 F1 — a CLOSED fix ticket is never reused, and the rounds are capped", () => {
  /**
   * The finding: the reuse decision only looked at the RECORD, never at the fix
   * ticket. A dev who closes the sync_fix without landing the merge left CI
   * blocked on a ticket that can never fire another `done` event — a permanent
   * wedge, or (with the reconcile sweep re-readying CI) an invisible loop that
   * files nothing and says nothing.
   *
   * So the assertions here are mostly NEGATIVE and they are about the BLOCKER
   * EDGE, not the return value: `addBlockers` must never be handed the closed id.
   * A test that only checked `fixTicketId` in the result would pass while still
   * pointing the edge at the corpse.
   */
  const FIX2 = "TEAM-501";
  const conflictRoutes = () => ({
    [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
    [`POST ${mergesPath()}`]: { status: 409, body: { message: "Merge conflict" } },
    [`GET ${comparePath(HEAD, BASE)}`]: { status: 200, body: { files: [{ filename: "a.ts" }] } },
    [`GET ${comparePath(BASE, HEAD)}`]: { status: 200, body: { files: [{ filename: "a.ts" }] } },
  });
  const priorConflict = (over = {}) => ({
    ciTicketId: CI, baseHeadSha: MAIN_SHA, status: "conflict", fixTicketId: FIX_ID, files: ["b.ts"], ...over,
  });
  const runningCi = () => ({ [CI]: { agentId: "agentcore_hub_ci_agent", status: "running" } });
  /** every id ever passed to addBlockers, flattened */
  const blockedOn = (deps) => deps.addBlockers.mock.calls.flatMap(([, ids]) => ids);

  it("(a) prior fix is DONE and the branch still conflicts → a round-2 ticket, and the closed id is never blocked on", async () => {
    const { deps, event } = makeDeps(conflictRoutes(), {
      getTicketStatus: vi.fn(async () => "done"),
      invokeTickets: vi.fn(async () => ({ key: FIX2 })),
    });
    const wf = makeWorkflow({ syncMain: priorConflict(), agentTasks: runningCi() });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(deps.getTicketStatus).toHaveBeenCalledWith(FIX_ID);
    expect(r).toMatchObject({ outcome: "conflict", fixTicketId: FIX2, round: 2, priorFixTicketId: FIX_ID });

    expect(deps.invokeTickets).toHaveBeenCalledTimes(1);
    const [tool, payload] = deps.invokeTickets.mock.calls[0];
    expect(tool).toBe("create_ticket");
    expect(payload.spawned_by).toEqual({ kind: "sync_fix", ciTicketId: CI, priorFixTicketId: FIX_ID, round: 2 });
    // …and the lineage SURVIVES the tickets Lambda: sanitizeSpawnedBy drops any
    // key that is not allow-listed, silently, so the round would otherwise be
    // written by the orchestrator and thrown away on arrival.
    expect(sanitizeSpawnedBy(payload.spawned_by).value).toEqual(payload.spawned_by);
    // Round 1 and round 2 would otherwise have byte-identical summaries.
    expect(payload.summary).toContain("(round 2)");
    expect(payload.description).toContain(FIX_ID);
    expect(payload.description).toContain("round 2");

    expect(deps.addBlockers).toHaveBeenCalledTimes(1);
    expect(deps.addBlockers).toHaveBeenCalledWith(CI, [FIX2]);
    expect(blockedOn(deps)).not.toContain(FIX_ID); // the whole point of the finding
    expect(deps.store.setSyncMain).toHaveBeenCalledWith(WF, expect.objectContaining({
      status: "conflict", fixTicketId: FIX2, round: 2, priorFixTicketId: FIX_ID,
    }));
    expect(event("workflow.sync_conflict")[0].detail).toMatchObject({
      fixTicketId: FIX2, round: 2, priorFixTicketId: FIX_ID, priorStatus: "done",
    });
  });

  it("every closed status counts, case-folded — and `cancelled` is not special-cased away", async () => {
    for (const status of ["done", "Done", " CANCELLED ", "cancelled", "skipped"]) {
      const { deps } = makeDeps(conflictRoutes(), {
        getTicketStatus: vi.fn(async () => status),
        invokeTickets: vi.fn(async () => ({ key: FIX2 })),
      });
      const wf = makeWorkflow({ syncMain: priorConflict(), agentTasks: runningCi() });
      const r = await syncBeforeCi(wf, ciTicket(), deps);
      expect(r, `status ${JSON.stringify(status)}`).toMatchObject({ fixTicketId: FIX2, round: 2 });
      expect(blockedOn(deps), `status ${JSON.stringify(status)}`).toEqual([FIX2]);
    }
  });

  it("a pre-TEAM-4131 record has no `round` — one filed ticket IS round 1, so the closed one becomes round 2", async () => {
    const { deps } = makeDeps(conflictRoutes(), {
      getTicketStatus: vi.fn(async () => "done"),
      invokeTickets: vi.fn(async () => ({ key: FIX2 })),
    });
    // No `round` key at all: the record was written by the code this fix replaces.
    const wf = makeWorkflow({ syncMain: priorConflict(), agentTasks: runningCi() });
    expect(await syncBeforeCi(wf, ciTicket(), deps)).toMatchObject({ round: 2 });
  });

  it("(b) prior fix is still OPEN → reuse exactly as before, no second ticket", async () => {
    for (const status of ["ready", "in_progress", "blocked", "in_review"]) {
      const { deps, event } = makeDeps(conflictRoutes(), { getTicketStatus: vi.fn(async () => status) });
      const wf = makeWorkflow({ syncMain: priorConflict({ round: 1 }), agentTasks: runningCi() });

      const r = await syncBeforeCi(wf, ciTicket(), deps);

      expect(r, status).toMatchObject({
        outcome: "conflict", fixTicketId: FIX_ID, reason: "already_ticketed", round: 1, files: ["b.ts"],
      });
      expect(r.reusedUnverified, status).toBeUndefined();
      expect(deps.invokeTickets, status).not.toHaveBeenCalled();
      expect(blockedOn(deps), status).toEqual([FIX_ID]);
      expect(event("workflow.sync_conflict")[0].detail).toMatchObject({ alreadyTicketed: true, reusedUnverified: false });
    }
  });

  it("(c) the status lookup THROWS → reuse, marked unverified, never a duplicate ticket", async () => {
    const { deps, event } = makeDeps(conflictRoutes(), {
      getTicketStatus: vi.fn(async () => { throw new Error("dynamodb down"); }),
    });
    const wf = makeWorkflow({ syncMain: priorConflict({ round: 2 }), agentTasks: runningCi() });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    // Fail OPEN to the pre-4131 behaviour: a ticket-store blip must not start
    // filing duplicate tickets at a dev. The marker is how the timeline says the
    // reuse was never confirmed.
    expect(r).toMatchObject({ outcome: "conflict", fixTicketId: FIX_ID, reason: "already_ticketed", reusedUnverified: true });
    expect(deps.invokeTickets).not.toHaveBeenCalled();
    expect(blockedOn(deps)).toEqual([FIX_ID]);
    expect(event("workflow.sync_conflict")[0].detail).toMatchObject({ reusedUnverified: true, round: 2 });
    expect(deps.store.setSyncMain).toHaveBeenCalledWith(WF, expect.objectContaining({ reusedUnverified: true }));
  });

  it("a MISSING ticket (null) is unknown, not closed — the fail-open direction is 'keep today's behaviour'", async () => {
    const { deps } = makeDeps(conflictRoutes(), { getTicketStatus: vi.fn(async () => null) });
    const wf = makeWorkflow({ syncMain: priorConflict(), agentTasks: runningCi() });
    const r = await syncBeforeCi(wf, ciTicket(), deps);
    expect(r).toMatchObject({ fixTicketId: FIX_ID, reason: "already_ticketed", reusedUnverified: true });
    expect(deps.invokeTickets).not.toHaveBeenCalled();
  });

  it("no getTicketStatus seam wired at all → reuse unverified (an older deps object must not change behaviour)", async () => {
    const { deps } = makeDeps(conflictRoutes());
    const wf = makeWorkflow({ syncMain: priorConflict(), agentTasks: runningCi() });
    expect(await syncBeforeCi(wf, ciTicket(), deps)).toMatchObject({
      fixTicketId: FIX_ID, reason: "already_ticketed", reusedUnverified: true,
    });
  });

  it("(d) the round cap parks the run: no new ticket, and NOTHING is blocked on the closed id", async () => {
    const { deps, event } = makeDeps(conflictRoutes(), {
      getTicketStatus: vi.fn(async () => "done"),
      maxSyncFixRounds: 3,
    });
    const wf = makeWorkflow({ syncMain: priorConflict({ round: 3 }), agentTasks: runningCi() });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r).toMatchObject({
      outcome: "conflict", reason: "round_cap", round: 3, priorFixTicketId: FIX_ID, parked: true,
    });
    expect(r.fixTicketId).toBeUndefined(); // there is nothing to wait on, by design
    expect(deps.invokeTickets).not.toHaveBeenCalled();
    expect(deps.addBlockers).not.toHaveBeenCalled();
    expect(event("workflow.sync_conflict_parked")[0].detail).toMatchObject({
      ticketId: CI, base: BASE, head: HEAD, priorFixTicketId: FIX_ID, priorStatus: "done", round: 3, maxRounds: 3,
    });
    expect(deps.store.setSyncMain).toHaveBeenCalledWith(WF, expect.objectContaining({
      status: "parked", fixTicketId: null, priorFixTicketId: FIX_ID, round: 3,
    }));
    // The claim IS released: leaving the entry "running" forever is the other
    // shape of the same wedge. A re-dispatch is harmless — see the next test.
    expect(deps.store.setTaskStatus).toHaveBeenCalledWith(WF, CI, "ready");
    expect(wf.agentTasks[CI].status).toBe("ready");
    // outcome conflict ⇒ the caller does not dispatch CI.
    expect(r.outcome).toBe("conflict");
  });

  it("a PARKED record short-circuits every redelivery: no merge, no ticket, no blocker, no write", async () => {
    const { deps, gh: g } = makeDeps(conflictRoutes(), { getTicketStatus: vi.fn(async () => "done") });
    const wf = makeWorkflow({
      syncMain: { ciTicketId: CI, baseHeadSha: MAIN_SHA, status: "parked", fixTicketId: null, priorFixTicketId: FIX_ID, round: 3, files: ["b.ts"] },
      agentTasks: runningCi(),
    });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "conflict", reason: "round_cap", round: 3, priorFixTicketId: FIX_ID, parked: true, files: ["b.ts"] });
    // Only the idempotency-key read. No POST /merges — a parked run must not keep
    // re-attempting a merge that provably conflicts.
    expect(g.keys()).toEqual([`GET ${branchesPath()}`]);
    expect(deps.getTicketStatus).not.toHaveBeenCalled();
    expect(deps.invokeTickets).not.toHaveBeenCalled();
    expect(deps.addBlockers).not.toHaveBeenCalled();
    expect(deps.store.setSyncMain).not.toHaveBeenCalled();
    expect(deps.store.setTaskStatus).not.toHaveBeenCalled();
    expect(deps.publishEvent).not.toHaveBeenCalled(); // one parked event, not one per redelivery
  });

  it("main MOVING un-parks the run — a new baseHeadSha is a new conflict, so the rounds start over", async () => {
    const { deps } = makeDeps(conflictRoutes(), {
      getTicketStatus: vi.fn(async () => "done"),
      invokeTickets: vi.fn(async () => ({ key: FIX2 })),
    });
    const wf = makeWorkflow({
      syncMain: { ciTicketId: CI, baseHeadSha: "0".repeat(40), status: "parked", priorFixTicketId: FIX_ID, round: 3 },
      agentTasks: runningCi(),
    });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "conflict", fixTicketId: FIX2, round: 1 });
    expect(deps.getTicketStatus).not.toHaveBeenCalled(); // no prior fix for THIS head
    expect(deps.invokeTickets.mock.calls[0][1].spawned_by).toEqual({ kind: "sync_fix", ciTicketId: CI });
  });

  it("maxSyncFixRounds is overridable: with a cap of 1, one closed ticket parks immediately", async () => {
    const { deps } = makeDeps(conflictRoutes(), {
      getTicketStatus: vi.fn(async () => "done"),
      maxSyncFixRounds: 1,
    });
    const wf = makeWorkflow({ syncMain: priorConflict({ round: 1 }), agentTasks: runningCi() });
    const r = await syncBeforeCi(wf, ciTicket(), deps);
    expect(r).toMatchObject({ reason: "round_cap", round: 1 });
    expect(deps.invokeTickets).not.toHaveBeenCalled();
  });

  it("a garbage cap falls back to the default rather than parking on round 1", async () => {
    for (const cap of [0, -3, NaN, "three", null]) {
      const { deps } = makeDeps(conflictRoutes(), {
        getTicketStatus: vi.fn(async () => "done"),
        invokeTickets: vi.fn(async () => ({ key: FIX2 })),
        maxSyncFixRounds: cap,
      });
      const wf = makeWorkflow({ syncMain: priorConflict({ round: 1 }), agentTasks: runningCi() });
      // round 2 <= the default 3 → still ticketed, not parked.
      expect(await syncBeforeCi(wf, ciTicket(), deps), String(cap)).toMatchObject({ fixTicketId: FIX2, round: 2 });
    }
  });

  it("the round-2 fix contract still passes the tickets Lambda's own validateFixContract", async () => {
    const { deps } = makeDeps(conflictRoutes(), {
      getTicketStatus: vi.fn(async () => "done"),
      invokeTickets: vi.fn(async () => ({ key: FIX2 })),
    });
    const wf = makeWorkflow({ syncMain: priorConflict(), agentTasks: runningCi() });
    await syncBeforeCi(wf, ciTicket(), deps);
    const { fix_contract } = deps.invokeTickets.mock.calls[0][1];
    expect(validateFixContract(fix_contract, { kind: "sync_fix" }).ok).toBe(true);
  });

  it("create_ticket failing on a round-2 attempt fails OPEN and burns no round", async () => {
    const { deps } = makeDeps(conflictRoutes(), {
      getTicketStatus: vi.fn(async () => "done"),
      invokeTickets: vi.fn(async () => { throw new Error("tickets lambda down"); }),
    });
    const wf = makeWorkflow({ syncMain: priorConflict({ round: 2 }), agentTasks: runningCi() });

    const r = await syncBeforeCi(wf, ciTicket(), deps);

    // CI dispatches un-synced (pre-FR-6 behaviour) rather than being held on a
    // closed ticket, and the persisted record carries NO round: nothing was filed,
    // so nothing may be counted against the human-escalation budget.
    expect(r).toMatchObject({ outcome: "skipped", reason: "conflict_unticketed" });
    expect(deps.addBlockers).not.toHaveBeenCalled();
    const [, record] = deps.store.setSyncMain.mock.calls.at(-1);
    expect(record).toMatchObject({ status: "conflict", fixTicketId: null, priorFixTicketId: FIX_ID });
    expect(record.round).toBeUndefined();
  });
});

describe("every other merge failure fails OPEN", () => {
  for (const status of [404, 422, 500, 502]) {
    it(`${status} → skipped with the status, sync_skipped, no ticket, no setSyncMain`, async () => {
      const { deps, event } = makeDeps({
        [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
        [`POST ${mergesPath()}`]: { status, body: { message: "nope" } },
      });

      const r = await syncBeforeCi(makeWorkflow(), ciTicket(), deps);

      expect(r.outcome).toBe("skipped");
      expect(r.status).toBe(status);
      expect(r.reason).toMatch(/merge_unexpected_status|merge_failed/);
      expect(event("workflow.sync_skipped")[0].detail).toMatchObject({ status, base: BASE, head: HEAD });
      expect(deps.invokeTickets).not.toHaveBeenCalled();
      expect(deps.store.setSyncMain).not.toHaveBeenCalled();
    });
  }

  it("a network throw with no .status → skipped, still no writes", async () => {
    const { deps, event } = makeDeps({
      [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
      [`POST ${mergesPath()}`]: () => { throw new Error("ECONNRESET"); },
    });

    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), deps);

    expect(r).toMatchObject({ outcome: "skipped", reason: "merge_failed", status: null });
    expect(event("workflow.sync_skipped")).toHaveLength(1);
    expect(deps.store.setSyncMain).not.toHaveBeenCalled();
  });
});

// ─── outer safety ────────────────────────────────────────────────────────────

describe("outer safety — a bug in here can never wedge the CI dispatch", () => {
  const okRoutes = {
    [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
    [`POST ${mergesPath()}`]: { status: 201, body: { sha: MERGE_SHA } },
  };

  it("publishEvent throwing on branch_synced does not lose the sync", async () => {
    const { deps } = makeDeps(okRoutes, {
      publishEvent: vi.fn(async (_t, type) => { if (type === "workflow.branch_synced") throw new Error("eventbridge down"); }),
    });
    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "synced", sha: MERGE_SHA });
    expect(deps.store.setSyncMain).toHaveBeenCalledTimes(1); // the record still lands
  });

  it("store.setSyncMain throwing does not change the outcome", async () => {
    const { deps } = makeDeps(okRoutes, {
      store: { setSyncMain: vi.fn(async () => { throw new Error("ddb down"); }), setTaskStatus: vi.fn(async () => {}) },
    });
    expect(await syncBeforeCi(makeWorkflow(), ciTicket(), deps)).toMatchObject({ outcome: "synced" });
  });

  it("addBlockers AND setTaskStatus both throwing still returns conflict — CI is held on the real ticket", async () => {
    const { deps } = makeDeps(
      {
        [`GET ${branchesPath()}`]: { status: 200, body: { commit: { sha: MAIN_SHA } } },
        [`POST ${mergesPath()}`]: { status: 409, body: {} },
      },
      {
        addBlockers: vi.fn(async () => { throw new Error("nope"); }),
        store: { setSyncMain: vi.fn(async () => {}), setTaskStatus: vi.fn(async () => { throw new Error("nope"); }) },
      }
    );
    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), deps);
    expect(r).toMatchObject({ outcome: "conflict", fixTicketId: FIX_ID });
  });

  it("a deps object missing every optional seam does not throw", async () => {
    const g = gh(okRoutes);
    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), { githubApi: g.api, mode: "enforce" });
    expect(r).toMatchObject({ outcome: "synced" });
  });

  it("a garbage workflow (no repoConfig at all) returns skipped, never throws", async () => {
    const { deps } = makeDeps(okRoutes);
    expect(await syncBeforeCi({}, ciTicket(), deps)).toMatchObject({ outcome: "skipped" });
    expect(await syncBeforeCi(null, null, deps)).toMatchObject({ outcome: "skipped" });
  });

  it("an internal throw (githubApi is not a function-shaped seam) degrades to skipped", async () => {
    const r = await syncBeforeCi(makeWorkflow(), ciTicket(), {
      githubApi: () => { throw new TypeError("boom"); },
      mode: "enforce",
    });
    expect(r.outcome).toBe("skipped");
  });
});
