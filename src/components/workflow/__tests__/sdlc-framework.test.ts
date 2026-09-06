import { describe, it, expect } from 'vitest';
import {
  resolveSdlcFramework,
  SDLC_BADGE_META,
} from '@/lib/workflow/sdlc-framework';
import type { WorkflowState } from '@/lib/workflow/types';

describe('SDLC framework helper (TEAM-3048)', () => {
  // ─── resolveSdlcFramework — normalization ─────────────────────────────────

  describe('resolveSdlcFramework', () => {
    it('returns "playbook" for the exact string "playbook"', () => {
      expect(resolveSdlcFramework('playbook')).toBe('playbook');
    });

    it('returns "aidlc" only for the exact string "aidlc"', () => {
      expect(resolveSdlcFramework('aidlc')).toBe('aidlc');
    });

    it('returns "standard" for the exact string "standard"', () => {
      expect(resolveSdlcFramework('standard')).toBe('standard');
    });

    // The framework is stamped from the def at start, so a row without one is a
    // legacy standard run — it must NOT masquerade as a playbook run.
    it('defaults undefined to "standard"', () => {
      expect(resolveSdlcFramework(undefined)).toBe('standard');
    });

    it('defaults null to "standard"', () => {
      expect(resolveSdlcFramework(null)).toBe('standard');
    });

    it('defaults empty string to "standard"', () => {
      expect(resolveSdlcFramework('')).toBe('standard');
    });

    it('defaults unrecognized strings to "standard"', () => {
      expect(resolveSdlcFramework('some-future-value')).toBe('standard');
      expect(resolveSdlcFramework('AIDLC')).toBe('standard');
      expect(resolveSdlcFramework('ai-dlc')).toBe('standard');
    });

    it('defaults non-strings to "standard"', () => {
      expect(resolveSdlcFramework(42)).toBe('standard');
      expect(resolveSdlcFramework({})).toBe('standard');
      expect(resolveSdlcFramework(true)).toBe('standard');
    });
  });

  // ─── SDLC_BADGE_META — copy of record ──────────────────────────────────────

  describe('SDLC_BADGE_META', () => {
    it('has the correct labels', () => {
      expect(SDLC_BADGE_META.standard.label).toBe('STANDARD');
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

    it('the two tooltips differ', () => {
      expect(SDLC_BADGE_META.playbook.tooltip).not.toBe(SDLC_BADGE_META.aidlc.tooltip);
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

    it('a state without the field compiles and defaults to the STANDARD label', () => {
      const withoutField: WorkflowState = { ...base };
      const fw = resolveSdlcFramework(withoutField.sdlcFramework ?? withoutField.input?.sdlcFramework);
      expect(SDLC_BADGE_META[fw].label).toBe('STANDARD');
    });

    it('a state with sdlcFramework: "playbook" yields the PLAYBOOK label', () => {
      const playbook: WorkflowState = { ...base, sdlcFramework: 'playbook' };
      const fw = resolveSdlcFramework(playbook.sdlcFramework ?? playbook.input?.sdlcFramework);
      expect(SDLC_BADGE_META[fw].label).toBe('PLAYBOOK');
    });
  });
});
