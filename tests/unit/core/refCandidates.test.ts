import { refCandidates } from '../../../src/core/refs';

describe('refCandidates', () => {
  it('uses the default branch for a push to main', () => {
    expect(refCandidates({ current: 'refs/heads/main', defaultBranch: 'main' })).toEqual({
      current: 'refs/heads/main',
      restore: ['refs/heads/main'],
    });
  });

  it('adds the base branch and the default branch for a pull request', () => {
    expect(
      refCandidates({ current: 'refs/pull/7/merge', baseRef: 'develop', defaultBranch: 'main' })
    ).toEqual({
      current: 'refs/pull/7/merge',
      restore: ['refs/pull/7/merge', 'refs/heads/develop', 'refs/heads/main'],
    });
  });

  it('falls back to the default branch for a tag', () => {
    expect(refCandidates({ current: 'refs/tags/v1.2.3', defaultBranch: 'main' })).toEqual({
      current: 'refs/tags/v1.2.3',
      restore: ['refs/tags/v1.2.3', 'refs/heads/main'],
    });
  });

  it('returns no candidates without a current ref', () => {
    expect(refCandidates({ baseRef: 'develop', defaultBranch: 'main' })).toEqual({
      current: undefined,
      restore: [],
    });
  });

  it('ignores an empty base ref and default branch', () => {
    expect(refCandidates({ current: 'refs/heads/x', baseRef: ' ', defaultBranch: '' })).toEqual({
      current: 'refs/heads/x',
      restore: ['refs/heads/x'],
    });
  });
});
