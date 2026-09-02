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
