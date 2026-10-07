import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CANCEL_REASON_MAX } from '@/lib/workflow/cancel-run';

/**
 * TEAM-5360 — the cancel/stop dialog caps its reason at the SAME length the
 * routes enforce (400 reason_too_long, never clamped). cancel-run.ts pulls the
 * AWS SDK, so the client component keeps a local copy; this pins the two together
 * (source-content assertion, the WorkflowBoard convention — TEAM-2141).
 */
describe('CancelConfirmationModal REASON_MAX', () => {
  it('equals CANCEL_REASON_MAX', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../CancelConfirmationModal.tsx'), 'utf-8');
    const m = /const REASON_MAX = (\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(CANCEL_REASON_MAX);
  });
});
