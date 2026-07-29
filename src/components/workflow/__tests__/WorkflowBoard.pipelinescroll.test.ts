import { describe, it, expect } from 'vitest';
import { PIPELINE_STYLES } from '../WorkflowBoard';

function extractRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\{([^}]+)\\}`));
  return match ? match[1] : '';
}

describe('WorkflowBoard pipeline scroll fix', () => {
  it('should NOT use align-items:center on .pipeline-viz to prevent left-scroll clipping', () => {
    const rule = extractRule(PIPELINE_STYLES, '.pipeline-viz');
    expect(rule).toContain('align-items:flex-start');
    expect(rule).not.toContain('align-items:center');
  });

  it('should use margin-inline:auto on .pipeline-canvas for wide-viewport centering', () => {
    const rule = extractRule(PIPELINE_STYLES, '.pipeline-canvas');
    expect(rule).toContain('margin-inline:auto');
  });

  it('should use margin-inline:auto on .pipeline-top-bar for wide-viewport centering', () => {
    const rule = extractRule(PIPELINE_STYLES, '.pipeline-top-bar');
    expect(rule).toContain('margin-inline:auto');
  });
});
