import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveSdlcFramework,
  SDLC_BADGE_META,
} from '@/lib/workflow/sdlc-framework';
import type { WorkflowState } from '@/lib/workflow/types';

describe('SDLC framework badge (TEAM-3048)', () => {
  // ─── resolveSdlcFramework — normalization ─────────────────────────────────

  describe('resolveSdlcFramework', () => {
    it('returns "playbook" for the exact string "playbook"', () => {
      expect(resolveSdlcFramework('playbook')).toBe('playbook');
    });

    it('returns "aidlc" only for the exact string "aidlc"', () => {
      expect(resolveSdlcFramework('aidlc')).toBe('aidlc');
    });

    it('defaults undefined to "playbook"', () => {
      expect(resolveSdlcFramework(undefined)).toBe('playbook');
    });

    it('defaults null to "playbook"', () => {
      expect(resolveSdlcFramework(null)).toBe('playbook');
    });

    it('defaults empty string to "playbook"', () => {
      expect(resolveSdlcFramework('')).toBe('playbook');
    });

    it('defaults unrecognized strings to "playbook"', () => {
      expect(resolveSdlcFramework('some-future-value')).toBe('playbook');
      expect(resolveSdlcFramework('AIDLC')).toBe('playbook');
      expect(resolveSdlcFramework('ai-dlc')).toBe('playbook');
    });

    it('defaults non-strings to "playbook"', () => {
      expect(resolveSdlcFramework(42)).toBe('playbook');
      expect(resolveSdlcFramework({})).toBe('playbook');
      expect(resolveSdlcFramework(true)).toBe('playbook');
    });
  });

  // ─── SDLC_BADGE_META — copy of record ──────────────────────────────────────

  describe('SDLC_BADGE_META', () => {
    it('has the correct labels', () => {
      expect(SDLC_BADGE_META.playbook.label).toBe('PLAYBOOK');
      expect(SDLC_BADGE_META.aidlc.label).toBe('AI-DLC');
    });

    it('playbook tooltip names the intent/spec/plan artifact triad', () => {
      expect(SDLC_BADGE_META.playbook.tooltip).toBe(
        'Playbook framework — expect intent, spec, and plan artifacts.'
      );
    });

    it('aidlc tooltip names the user_stories/tasks_plan/validation_report artifact triad', () => {
      expect(SDLC_BADGE_META.aidlc.tooltip).toBe(
        'AI-DLC framework — expect user_stories, tasks_plan, and validation_report artifacts.'
      );
    });

    it('carries the board and list class names per framework', () => {
      expect(SDLC_BADGE_META.playbook.boardClassName).toBe('sdlc-badge sdlc-badge--playbook');
      expect(SDLC_BADGE_META.aidlc.boardClassName).toBe('sdlc-badge sdlc-badge--aidlc');
      expect(SDLC_BADGE_META.playbook.listClassName).toContain('text-[var(--accent-fg)]');
      expect(SDLC_BADGE_META.playbook.listClassName).toContain('bg-[var(--accent-subtle)]');
      expect(SDLC_BADGE_META.aidlc.listClassName).toContain('text-[var(--violet-fg)]');
      expect(SDLC_BADGE_META.aidlc.listClassName).toContain('bg-[var(--violet-subtle)]');
    });
  });

  // ─── Board badge — source-content assertions (convention: TEAM-2141) ──────

  describe('WorkflowBoard.tsx badge markup', () => {
    const boardContent = fs.readFileSync(
      path.resolve(__dirname, '../WorkflowBoard.tsx'),
      'utf-8'
    );

    it('renders the badge via SDLC_BADGE_META (no raw-value branching)', () => {
      expect(boardContent).toContain('SDLC_BADGE_META[fw].boardClassName');
      expect(boardContent).toContain('SDLC_BADGE_META[fw].tooltip');
      expect(boardContent).toContain('SDLC_BADGE_META[fw].label');
    });

    it('reads state.sdlcFramework with fallback to state.input.sdlcFramework', () => {
      expect(boardContent).toMatch(
        /resolveSdlcFramework\(state\??\.sdlcFramework \?\? state\??\.input\?\.sdlcFramework\)/
      );
    });

    it('places the badge as the first child inside pipeline-status-header, ungated', () => {
      const headerIdx = boardContent.indexOf('className={`pipeline-status-header');
      expect(headerIdx).toBeGreaterThan(-1);
      const afterHeader = boardContent.slice(headerIdx, headerIdx + 600);
      // Badge span comes before the status text expression...
      const badgeIdx = afterHeader.indexOf('SDLC_BADGE_META[fw].boardClassName');
      const statusTextIdx = afterHeader.indexOf('isComplete ? "Complete"');
      expect(badgeIdx).toBeGreaterThan(-1);
      expect(statusTextIdx).toBeGreaterThan(badgeIdx);
      // ...and is not conditionally gated (no `&&` / ternary guard around the span)
      const between = afterHeader.slice(0, badgeIdx);
      expect(between).not.toContain('isComplete &&');
      expect(between).not.toContain('streamStatus');
      expect(between).not.toContain('replayEvents');
    });

    it('defines the .sdlc-badge CSS rules in PIPELINE_STYLES', () => {
      expect(boardContent).toContain(
        '.sdlc-badge{position:absolute;right:calc(100% + 10px);top:50%;transform:translateY(-50%);'
      );
      expect(boardContent).toContain(
        '.sdlc-badge--playbook{color:var(--accent-fg);background:var(--accent-subtle)}'
      );
      expect(boardContent).toContain(
        '.sdlc-badge--aidlc{color:var(--violet-fg);background:var(--violet-subtle)}'
      );
    });
  });

  // ─── Sidebar badge — source-content assertions ─────────────────────────────

  describe('workflow/page.tsx sidebar badge markup', () => {
    const pageContent = fs.readFileSync(
      path.resolve(__dirname, '../../../app/workflow/page.tsx'),
      'utf-8'
    );

    it('renders the list badge via SDLC_BADGE_META adjacent to the def pill', () => {
      expect(pageContent).toContain('SDLC_BADGE_META[fw].listClassName');
      const wrapIdx = pageContent.indexOf('className="flex items-center gap-1 min-w-0"');
      expect(wrapIdx).toBeGreaterThan(-1);
      const group = pageContent.slice(wrapIdx, wrapIdx + 900);
      // def pill first, badge right after, inside the same wrapper span
      expect(group.indexOf('{defLabel}')).toBeGreaterThan(-1);
      expect(group.indexOf('SDLC_BADGE_META[fw].listClassName')).toBeGreaterThan(
        group.indexOf('{defLabel}')
      );
    });

    it('leaves the def pill markup intact', () => {
      expect(pageContent).toContain(
        'className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] border border-[var(--color-border)] font-medium uppercase tracking-wider truncate"'
      );
      expect(pageContent).toContain('title={def.name}');
    });

    it('resolves fw from the workflow summary', () => {
      expect(pageContent).toContain('resolveSdlcFramework(workflow.sdlcFramework)');
    });
  });

  // ─── Type-level fixture — both shapes compile ──────────────────────────────

  describe('WorkflowState fixture compatibility', () => {
    const base: Omit<WorkflowState, 'sdlcFramework'> = {
      id: 'wf_test',
      phase: 'intake',
      epicId: 'TEAM-1',
      repoConfig: { layout: 'monorepo', repos: [] },
      input: {
        title: 't',
        description: 'd',
        repoConfig: { layout: 'monorepo', repos: [] },
        sources: [],
      },
      agentTasks: {},
      messages: [],
      humanNotifications: [],
      startedAt: '2026-08-27T00:00:00Z',
    };

    it('a state with sdlcFramework: "aidlc" compiles and yields the AI-DLC label', () => {
      const withField: WorkflowState = { ...base, sdlcFramework: 'aidlc' };
      const fw = resolveSdlcFramework(withField.sdlcFramework ?? withField.input?.sdlcFramework);
      expect(SDLC_BADGE_META[fw].label).toBe('AI-DLC');
    });

    it('a state without the field compiles and defaults to the PLAYBOOK label', () => {
      const withoutField: WorkflowState = { ...base };
      const fw = resolveSdlcFramework(withoutField.sdlcFramework ?? withoutField.input?.sdlcFramework);
      expect(SDLC_BADGE_META[fw].label).toBe('PLAYBOOK');
    });
  });
});
