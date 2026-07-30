import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('WorkflowBoard scroll regression (TEAM-2141)', () => {
  const boardContent = fs.readFileSync(
    path.resolve(__dirname, '../WorkflowBoard.tsx'),
    'utf-8'
  );
  const pageContent = fs.readFileSync(
    path.resolve(__dirname, '../../../app/workflow/page.tsx'),
    'utf-8'
  );

  it('pipeline-viz should use align-items:flex-start to prevent left clipping', () => {
    expect(boardContent).toContain(
      '.pipeline-viz{display:flex;flex-direction:column;align-items:flex-start;'
    );
    expect(boardContent).not.toMatch(/\.pipeline-viz\{[^}]*align-items:\s*center/);
  });

  it('pipeline-phases should have left padding as scroll gutter', () => {
    expect(boardContent).toMatch(/\.pipeline-phases\{[^}]*padding-left:\s*16px/);
  });

  it('pipeline-canvas and pipeline-top-bar should use margin-inline:auto for centering', () => {
    expect(boardContent).toMatch(/\.pipeline-canvas\{[^}]*margin-inline:\s*auto/);
    expect(boardContent).toMatch(/\.pipeline-top-bar\{[^}]*margin-inline:\s*auto/);
  });

  it('page wrapper should use overflow-x-hidden to prevent nested scroll conflict', () => {
    expect(pageContent).toContain('overflow-y-auto overflow-x-hidden');
    expect(pageContent).not.toMatch(/className="flex-1 overflow-auto"/);
  });
});
