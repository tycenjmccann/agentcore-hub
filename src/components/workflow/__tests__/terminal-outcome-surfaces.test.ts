import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TERMINAL_PHASES, SHIP_BLOCKED_OUTCOMES, isTerminalPhase } from '@/lib/workflow/types';

/**
 * TEAM-3755 F5 + F6 — the two surfaces that still carried a hand-rolled
 * "terminal means complete/error/cancelled" list after TEAM-3747 D2 added the
 * ship-blocked outcomes (deploy-blocked / static-ci-only):
 *
 *   F6 — the board's Cancel button, rendered on an already-finished run.
 *   F5 — the workflow-analyzer EventBridge rule, which only matched
 *        "workflow.complete", so a blocked close never triggered auto-analysis:
 *        the runs most worth analyzing were the only ones silently skipped.
 *
 * Both are source-content assertions (the WorkflowBoard convention — TEAM-2141 —
 * used by SdlcBadge.presence.test.ts / WorkflowBoard.scroll.test.ts: the board is
 * a 4k-line client component with no render harness, and deploy.sh is shell). The
 * expected values are DERIVED from the shared lists in src/lib/workflow/types.ts,
 * so adding a sixth terminal phase makes these fail rather than silently pass.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const boardContent = fs.readFileSync(
  path.resolve(__dirname, '../WorkflowBoard.tsx'),
  'utf-8'
);

describe('F6 — WorkflowBoard header controls gate on the SHARED terminal set', () => {
  it('renders Cancel behind !isTerminalPhase(state.phase)', () => {
    // The button itself is identified by its aria-label; walk back to the JSX
    // guard immediately above it.
    const cancelIdx = boardContent.indexOf('aria-label="Cancel workflow"');
    expect(cancelIdx).toBeGreaterThan(-1);
    const before = boardContent.slice(0, cancelIdx);
    const guard = before.slice(before.lastIndexOf('{state &&'));
    expect(guard).toContain('!isTerminalPhase(state.phase)');
  });

  it('no header control hand-rolls the old three-phase terminal list', () => {
    // The exact shape of the F6 bug: a literal chain that predates
    // SHIP_BLOCKED_OUTCOMES and therefore treats a blocked run as still running.
    expect(boardContent).not.toContain(
      'state.phase !== "complete" && state.phase !== "error" && state.phase !== "cancelled"'
    );
  });

  it('imports the shared helper rather than defining its own', () => {
    // No /s flag — the project's TS target predates it, and [^}] already spans
    // newlines, so a multi-line import block still matches.
    expect(boardContent).toMatch(/import\s*\{[^}]*isTerminalPhase[^}]*\}\s*from\s*['"]@\/lib\/workflow\/types['"]/);
    // Sanity-pin the helper the board now depends on: every ship-blocked outcome
    // reads terminal, so the Cancel button disappears on those runs.
    for (const outcome of SHIP_BLOCKED_OUTCOMES) {
      expect(isTerminalPhase(outcome)).toBe(true);
    }
    expect(isTerminalPhase('development')).toBe(false);
  });
});

/**
 * TEAM-3767 F8 — the THIRD hand-rolled terminal check, added by main's PR #293
 * (deploy-gate polling): `runActive` gated the /api/pipeline/status poll and the
 * amber "Deploy gate — awaiting approval" banner on `state.phase !== "complete"`
 * only. After the epic added the ship-blocked terminals, a deploy-blocked /
 * static-ci-only run — already finished — would keep polling every 20s and could
 * still render the banner. The fix routes `runActive` through the shared
 * isTerminalPhase predicate (same convention as F6's Cancel button), so all of
 * complete/error/cancelled/deploy-blocked/static-ci-only stop polling and clear
 * the banner, while active ship-phase runs are unchanged.
 *
 * Same source-content convention as F6 above (no render harness for the 4k-line
 * board); the expected semantics are DERIVED from the shared list so a sixth
 * terminal phase makes these fail rather than silently pass.
 */
describe('F8 — deploy-gate polling gates on the SHARED terminal set (TEAM-3767)', () => {
  // The poll/banner guard is the `runActive` binding; isolate its definition so
  // assertions can't be satisfied by the unrelated `isActive` column logic that
  // legitimately still tests phase !== "complete".
  const runActiveDef = (() => {
    const idx = boardContent.indexOf('const runActive =');
    expect(idx).toBeGreaterThan(-1);
    return boardContent.slice(idx, boardContent.indexOf(';', idx));
  })();

  it('runActive is derived from the shared !isTerminalPhase(state.phase) predicate', () => {
    expect(runActiveDef).toContain('!isTerminalPhase(state.phase)');
  });

  it('does NOT gate the poll on the old weaker complete-only literal (the F8 bug shape)', () => {
    expect(runActiveDef).not.toContain('state.phase !== "complete"');
  });

  it('the poll effect early-returns (no fetch) and clears the banner when !runActive', () => {
    // `if (!defHasShip || !runActive) { setDeployGate(null); return; }` — so a
    // terminal run neither fetches /api/pipeline/status nor keeps a banner; the
    // amber banner only renders from the deployGate state this clears.
    // TEAM-4336 turned the URL into a template literal (`?repo=` is appended per
    // run), so the anchor is the backtick form — still the fetch call itself.
    const effectIdx = boardContent.indexOf('fetch(`/api/pipeline/status');
    expect(effectIdx).toBeGreaterThan(-1);
    const before = boardContent.slice(0, effectIdx);
    const guard = before.slice(before.lastIndexOf('if (!defHasShip'));
    expect(guard).toContain('!runActive');
    expect(guard).toContain('setDeployGate(null)');
    expect(guard).toContain('return;');
    // The banner itself is downstream of that state — no deployGate, no banner.
    expect(boardContent).toContain('{deployGate && (');
  });

  it('every ship-blocked outcome reads terminal → no polling, no banner (deploy-blocked, static-ci-only)', () => {
    // Because runActive uses isTerminalPhase, each of these forces runActive=false
    // → the effect clears deployGate and never polls.
    expect(isTerminalPhase('deploy-blocked')).toBe(true);
    expect(isTerminalPhase('static-ci-only')).toBe(true);
    for (const outcome of SHIP_BLOCKED_OUTCOMES) {
      expect(isTerminalPhase(outcome)).toBe(true);
    }
  });

  it('an active ship-phase run still polls + can show the banner (no #293 regression)', () => {
    // "ship" is not terminal → runActive stays true for a live ship run, so the
    // deploy-gate poll + amber banner behave exactly as #293 shipped them.
    expect(isTerminalPhase('ship')).toBe(false);
  });
});

/**
 * TEAM-4336 — the deploy-gate banner is scoped to the run's OWN pipeline.
 *
 * The #293 poll read the ONE global pipeline (`data.stages`), which was correct
 * only while the hub deployed exactly one repo. With several repos in the CD
 * registry — each with its own CodePipeline, possibly in another region — that
 * read would surface repo Y's ManualApproval on repo X's board and invite a human
 * to approve the wrong production deploy. The poll now asks for the run's own
 * repo and matches the returned target by repo key before raising the banner, so
 * an unregistered-repo handoff run (whose only target is the env default, repo "")
 * shows nothing at all.
 *
 * Same source-content convention as F6/F8 above (no render harness for the 4k-line
 * board).
 */
describe('TEAM-4336 — the deploy-gate banner is scoped to the run\'s own pipeline', () => {
  /** The poll effect: from the guard through the setDeployGate call. */
  const pollEffect = (() => {
    const start = boardContent.indexOf('if (!defHasShip');
    expect(start).toBeGreaterThan(-1);
    const end = boardContent.indexOf('const id = setInterval(poll, 20000)', start);
    expect(end).toBeGreaterThan(start);
    return boardContent.slice(start, end);
  })();

  it('polls for the RUN\'s repo (state.repoConfig.repos[0].url), url-encoded', () => {
    expect(boardContent).toMatch(
      /const runRepoUrl = state\?\.repoConfig\?\.repos\?\.\[0\]\?\.url/
    );
    expect(pollEffect).toContain('?repo=${encodeURIComponent(runRepoUrl)}');
    // The param is omitted rather than sent empty when the def carries no repo.
    expect(pollEffect).toContain('runRepoUrl ?');
  });

  it('derives the gate from the MATCHING target only, never a global stage list', () => {
    expect(pollEffect).toContain('data.pipelines');
    expect(pollEffect).toContain('isSameRepo(runRepoUrl');
    expect(pollEffect).toContain('mine && waiting');
    // The exact pre-4336 cross-repo bug shape: any stage of the one global pipeline.
    expect(boardContent).not.toContain('(data.stages || [])');
  });

  it('re-polls when the run\'s repo changes (effect dependency)', () => {
    const depsIdx = boardContent.indexOf('}, [defHasShip, runActive');
    expect(depsIdx).toBeGreaterThan(-1);
    expect(boardContent.slice(depsIdx, boardContent.indexOf(']', depsIdx))).toContain('runRepoUrl');
  });

  it('the banner NAMES the pipeline it is asking a human to approve', () => {
    const bannerIdx = boardContent.indexOf('{deployGate && (');
    expect(bannerIdx).toBeGreaterThan(-1);
    const banner = boardContent.slice(bannerIdx, bannerIdx + 1200);
    expect(banner).toContain('deployGate.pipeline');
    expect(banner).toContain('deployGate.stage');
    // ...and the state it renders from carries that pipeline name.
    expect(boardContent).toContain('{ stage: string; pipeline: string; url?: string }');
  });

  it('isSameRepo is a LOCAL mirror — cd-registry is never value-imported client-side', () => {
    // src/lib/cd-registry.ts lazy-imports @aws-sdk/client-s3; importing it into a
    // client component would ship the AWS SDK to the browser (the same trade
    // src/config/modules.ts refused for isPipelineEnabled).
    expect(boardContent).toMatch(/function isSameRepo\(url: string \| undefined, key: string\): boolean/);
    expect(boardContent).not.toMatch(/^import\s+\{[^}]*normalizeRepoKey/m);
    expect(boardContent).not.toContain('from "@/lib/cd-registry"');
  });
});

describe('F5 — the analyzer EventBridge rule fires on every terminal outcome', () => {
  const deploySh = fs.readFileSync(
    path.join(REPO_ROOT, 'deploy/workflow-manager/deploy.sh'),
    'utf-8'
  );

  /** The single-quoted --event-pattern argument of the analyzer-trigger put-rule. */
  const eventPattern = (() => {
    const ruleIdx = deploySh.indexOf('"agentcore-hub-workflow-analyzer-trigger"');
    // Thrown at collection time on purpose: if the rule is renamed, every
    // assertion below is vacuous and must fail loudly rather than pass.
    if (ruleIdx < 0) throw new Error('analyzer-trigger put-rule not found in deploy.sh');
    const match = deploySh.slice(ruleIdx).match(/--event-pattern\s+'([^']+)'/);
    if (!match) throw new Error('analyzer-trigger rule has no --event-pattern');
    return match[1];
  })();

  it('is valid JSON with the orchestrator as its source', () => {
    // Shell-quoted JSON has no parser behind it at deploy time — a typo here is a
    // silent rule that matches nothing, so parse it in CI instead.
    const parsed = JSON.parse(eventPattern) as { source: string[]; 'detail-type': string[] };
    expect(parsed.source).toEqual(['agentcore-hub.orchestrator']);
    expect(Array.isArray(parsed['detail-type'])).toBe(true);
  });

  it('matches workflow.complete AND both ship-blocked closes', () => {
    const detailTypes: string[] = JSON.parse(eventPattern)['detail-type'];
    // Derived from the shared outcome list: closeWorkflowBlocked publishes
    // workflow.<outcome with - as _> (index.mjs), so a new outcome added to
    // SHIP_BLOCKED_OUTCOMES fails this until the rule learns about it.
    const expected = [
      'workflow.complete',
      ...SHIP_BLOCKED_OUTCOMES.map((o) => `workflow.${o.replace(/-/g, '_')}`),
    ];
    expect(detailTypes.sort()).toEqual(expected.sort());
  });

  it('the orchestrator really publishes those detail-types on a blocked close', () => {
    // Pins the producer side of the contract the rule depends on.
    const orchestrator = fs.readFileSync(
      path.join(REPO_ROOT, 'lambda/orchestrator/index.mjs'),
      'utf-8'
    );
    const detailTypes: string[] = JSON.parse(eventPattern)['detail-type'];
    for (const type of detailTypes) {
      expect(orchestrator).toContain(`"${type}"`);
    }
  });

  it('the analyzer treats those phases as terminal outcomes (no code branch needed)', () => {
    // The Lambda reads only source + detail.workflowId, but it does label the run
    // by phase — that set must cover everything the rule now delivers.
    const analyzer = fs.readFileSync(
      path.join(REPO_ROOT, 'lambda/workflow-analyzer/index.mjs'),
      'utf-8'
    );
    const declared = analyzer.match(/const TERMINAL_PHASES = new Set\(\[([^\]]*)\]\)/)?.[1] || '';
    const phases = declared.split(',').map((p) => p.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    expect(phases.sort()).toEqual([...TERMINAL_PHASES].sort());
  });
});

/**
 * TEAM-4403 — the deploy-gate banner is scoped to the RUN, not just the repo.
 *
 * TEAM-4336 (above) stopped repo Y's gate appearing on repo X's run, but within a
 * single repo the banner was still unscoped: it fired on ANY awaiting stage of that
 * repo's pipeline, so one parked ManualApproval on agentcore-hub-deploy showed on
 * every active hub run — including runs still in development that had never merged.
 * The gate must now prove it belongs to the run: the waiting execution's source
 * commit has to BE this run's merge commit, and a run with no merge commit must
 * neither poll nor banner.
 *
 * Same source-content convention as F6/F8/4336 above (no render harness for the
 * 4k-line board). The matching rule itself is unit-tested on the pure helpers in
 * src/lib/workflow/__tests__/deploy-gate.test.ts — these assertions only pin that
 * the board actually routes through them.
 */
describe('TEAM-4403 — the deploy-gate banner is scoped to the run that merged', () => {
  /** The poll effect: from the guard through the setDeployGate call. */
  const pollEffect = (() => {
    const start = boardContent.indexOf('if (!defHasShip');
    expect(start).toBeGreaterThan(-1);
    const end = boardContent.indexOf('const id = setInterval(poll, 20000)', start);
    expect(end).toBeGreaterThan(start);
    return boardContent.slice(start, end);
  })();

  it("derives the run's merge commit from agentTasks via the shared helper", () => {
    // agentTasks is keyed by ticketId, so there is no agentTasks[<agentId>] read —
    // mergeCommitOf scans the entries and prefers the release manager's.
    expect(boardContent).toMatch(/const runMergeCommit = mergeCommitOf\(state\?\.agentTasks\)/);
    expect(boardContent).toContain('import { mergeCommitOf, matchDeployGate } from "@/lib/workflow/deploy-gate"');
  });

  it('a run with no merge commit never polls and never banners', () => {
    // The guard short-circuits before the fetch, so a development-phase run costs
    // no request every 20s and can never raise the amber banner.
    expect(pollEffect).toContain('!runMergeCommit');
    const guard = pollEffect.slice(0, pollEffect.indexOf('let cancelled'));
    expect(guard).toContain('setDeployGate(null); return;');
    expect(guard.indexOf('!runMergeCommit')).toBeLessThan(guard.indexOf('setDeployGate(null)'));
  });

  it('the banner comes from matchDeployGate, never from "first awaiting stage"', () => {
    expect(pollEffect).toContain('matchDeployGate(mine?.stages, runMergeCommit)');
    // The exact pre-4403 bug shape: any awaiting stage of the run's pipeline.
    expect(pollEffect).not.toMatch(/\.find\(\s*\(s: \{ awaitingApproval\?: boolean \}\) => s\.awaitingApproval\s*\)/);
    // The repo scoping from TEAM-4336 is still in force — this narrows it further.
    expect(pollEffect).toContain('isSameRepo(runRepoUrl');
  });

  it('re-polls when the merge commit appears (effect dependency)', () => {
    // Without this the banner would stay dark for the whole run that just merged:
    // the guard flips only when the ship phase records the merge commit.
    const depsIdx = boardContent.indexOf('}, [defHasShip, runActive');
    expect(depsIdx).toBeGreaterThan(-1);
    expect(boardContent.slice(depsIdx, boardContent.indexOf(']', depsIdx))).toContain('runMergeCommit');
  });

  it('the pure helpers carry no AWS SDK into the browser bundle', () => {
    // Same trade as the board's local isSameRepo mirror (TEAM-4336, above):
    // @/lib/pipeline/status imports @aws-sdk/client-codepipeline, and CLAUDE.md
    // forbids one optional module importing another — so the helper lives under
    // @/lib/workflow and mirrors the pipeline stage shape structurally.
    expect(boardContent).not.toMatch(/from ['"]@\/lib\/pipeline\/status['"]/);
    const helper = fs.readFileSync(
      path.resolve(__dirname, '../../../lib/workflow/deploy-gate.ts'),
      'utf-8'
    );
    // Import statements only — the file's header comment names these modules to
    // explain why it does NOT import them, and that prose must stay allowed.
    expect(helper).not.toMatch(
      /^\s*(?:import|export)\b[^\n]*from\s*['"](?:@aws-sdk\/|@\/lib\/pipeline|@\/lib\/cd-registry)/m
    );
    expect(helper).not.toMatch(/require\(\s*['"](?:@aws-sdk\/|@\/lib\/pipeline|@\/lib\/cd-registry)/);
  });
});
