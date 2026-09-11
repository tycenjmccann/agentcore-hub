import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('SDLC framework badge presence (TEAM-3048 / TEAM-4408)', () => {
  // ─── Board badge — source-content assertions (convention: TEAM-2141) ──────

  describe('WorkflowBoard.tsx badge markup', () => {
    const boardContent = fs.readFileSync(
      path.resolve(__dirname, '../WorkflowBoard.tsx'),
      'utf-8'
    );

    it('renders the badge via sdlcBadgeFor (no raw SDLC_BADGE_META[fw] access)', () => {
      expect(boardContent).toContain('sdlcBadgeFor(fw)');
      expect(boardContent).toContain('sdlcBadge.boardClassName');
      expect(boardContent).toContain('sdlcBadge.tooltip');
      expect(boardContent).toContain('sdlcBadge.label');
    });

    it('reads state.sdlcFramework with fallback to state.input.sdlcFramework', () => {
      expect(boardContent).toMatch(
        /resolveSdlcFramework\(state\??\.sdlcFramework \?\? state\??\.input\?\.sdlcFramework\)/
      );
    });

    it('places the badge as the first child inside pipeline-status-header, gated only on overlay presence', () => {
      const headerIdx = boardContent.indexOf('className={`pipeline-status-header');
      expect(headerIdx).toBeGreaterThan(-1);
      const afterHeader = boardContent.slice(headerIdx, headerIdx + 600);
      // Badge span comes before the status text expression...
      const badgeIdx = afterHeader.indexOf('sdlcBadge.boardClassName');
      const statusTextIdx = afterHeader.indexOf('isComplete ? "Complete"');
      expect(badgeIdx).toBeGreaterThan(-1);
      expect(statusTextIdx).toBeGreaterThan(badgeIdx);
      // ...and is gated ONLY on overlay presence (sdlcBadge && ...) — never on
      // isComplete / streamStatus / replayEvents / catchingUp.
      const between = afterHeader.slice(0, badgeIdx);
      expect(between).toContain('sdlcBadge && ');
      expect(between).not.toContain('isComplete &&');
      expect(between).not.toContain('streamStatus');
      expect(between).not.toContain('replayEvents');
      expect(between).not.toContain('catchingUp');
    });

    it('defines the .sdlc-badge CSS rules in PIPELINE_STYLES, with no dead --standard variant', () => {
      expect(boardContent).toContain(
        '.sdlc-badge{position:absolute;right:calc(100% + 10px);top:50%;transform:translateY(-50%);'
      );
      expect(boardContent).toContain(
        '.sdlc-badge--playbook{color:var(--accent-fg);background:var(--accent-subtle)}'
      );
      expect(boardContent).toContain(
        '.sdlc-badge--aidlc{color:var(--violet-fg);background:var(--violet-subtle)}'
      );
      expect(boardContent).not.toContain('.sdlc-badge--standard');
    });
  });

  // ─── Sidebar badge — source-content assertions ─────────────────────────────

  describe('workflow/page.tsx sidebar badge markup', () => {
    const pageContent = fs.readFileSync(
      path.resolve(__dirname, '../../../app/workflow/page.tsx'),
      'utf-8'
    );

    it('renders the list badge via sdlcBadgeFor adjacent to the def pill, gated on overlay presence', () => {
      expect(pageContent).toContain('sdlcBadgeFor(fw)');
      expect(pageContent).toContain('sdlcBadge.listClassName');
      const wrapIdx = pageContent.indexOf('className="flex items-center gap-1 min-w-0"');
      expect(wrapIdx).toBeGreaterThan(-1);
      const group = pageContent.slice(wrapIdx, wrapIdx + 900);
      // def pill first, badge right after, inside the same wrapper span, gated on sdlcBadge
      expect(group.indexOf('{defLabel}')).toBeGreaterThan(-1);
      expect(group.indexOf('sdlcBadge.listClassName')).toBeGreaterThan(
        group.indexOf('{defLabel}')
      );
      expect(group).toContain('sdlcBadge && ');
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

    it('carries sdlcFramework onto the summary with input fallback', () => {
      expect(pageContent).toContain('w.sdlcFramework ?? w.input?.sdlcFramework');
    });
  });
});
