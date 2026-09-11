import { describe, it, expect } from 'vitest';
import { isSameRepo } from '../WorkflowBoard';

/**
 * TEAM-4421 / TEAM-4426 — a repo URL with a trailing slash AFTER `.git`
 * (`https://github.com/owner/repo.git/`) never matched: `.git` was stripped
 * before the trailing slash, so `/\.git$/` couldn't match past the `/`. The
 * deploy-gate poll's isSameRepo(runRepoUrl, p.repo) then never found the run's
 * own pipeline, so the banner never rendered.
 */
describe('isSameRepo', () => {
  it('matches a trailing-slash-after-.git remote (the TEAM-4421 regression)', () => {
    expect(isSameRepo('https://github.com/owner/repo.git/', 'owner/repo')).toBe(true);
    expect(isSameRepo('https://github.com/owner/repo/', 'owner/repo')).toBe(true);
    expect(isSameRepo('https://github.com/owner/repo.git', 'owner/repo')).toBe(true);
    expect(isSameRepo('git@github.com:owner/repo.git', 'owner/repo')).toBe(true);
    expect(isSameRepo('https://github.com/Owner/Repo.git/', 'owner/repo')).toBe(true);
    expect(isSameRepo('owner/repo.git//', 'owner/repo')).toBe(true);
  });

  it('still rejects a different repo and empty/undefined inputs', () => {
    expect(isSameRepo('https://github.com/owner/other.git/', 'owner/repo')).toBe(false);
    expect(isSameRepo(undefined, 'owner/repo')).toBe(false);
    expect(isSameRepo('', 'owner/repo')).toBe(false);
  });

  /**
   * TEAM-4441 (ship-review F1 on #529) — the TEAM-4421 reorder fixed
   * `.git/` but regressed the mirror-image `/.git` form: slashes were
   * stripped first (a no-op on this input), then `.git` left a trailing
   * `/` behind that was never stripped again.
   */
  it('matches a slash-before-.git remote (the TEAM-4441 regression)', () => {
    expect(isSameRepo('https://github.com/owner/repo/.git', 'owner/repo')).toBe(true);
    expect(isSameRepo('owner/repo/.git', 'owner/repo')).toBe(true);
    expect(isSameRepo('https://github.com/owner/repo/.git/', 'owner/repo')).toBe(true);
    expect(isSameRepo('https://github.com/Owner/Repo/.git', 'owner/repo')).toBe(true);
  });
});
