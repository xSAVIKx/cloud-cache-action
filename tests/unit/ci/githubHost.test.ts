import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const summaryMock = { addHeading: jest.fn(), write: jest.fn() };
const coreMock = {
  getInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  getState: jest.fn(),
  saveState: jest.fn(),
  summary: summaryMock,
};
jest.unstable_mockModule('@actions/core', () => coreMock);

const { GitHubActionsHost } = await import('../../../src/ci/github');
const { getHost, setHost } = await import('../../../src/ci/host');
const { log } = await import('../../../src/ci/log');

let dir: string;
let eventPath: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'github-host-'));
  eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  jest.clearAllMocks();
  setHost(undefined);
});

describe('GitHubActionsHost', () => {
  it('context maps the GitHub environment', () => {
    const host = new GitHubActionsHost({
      GITHUB_REPOSITORY: 'octo/app',
      RUNNER_OS: 'Linux',
      GITHUB_WORKSPACE: '/w',
      GITHUB_REF: 'refs/pull/7/merge',
      GITHUB_BASE_REF: 'develop',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: eventPath,
    });
    const ctx = host.context();
    expect(ctx.platform).toBe('github');
    expect(ctx.repository).toBe('octo/app');
    expect(ctx.refs.current).toBe('refs/pull/7/merge');
    expect(ctx.refs.restore).toEqual([
      'refs/pull/7/merge',
      'refs/heads/develop',
      'refs/heads/main',
    ]);
    expect(ctx.eventName).toBe('pull_request');
    expect(ctx.workspace).toBe('/w');
    expect(ctx.runnerOs).toBe('Linux');
  });

  it('context reads the environment at each call', () => {
    const saved = process.env.GITHUB_REF;
    try {
      const host = new GitHubActionsHost();
      process.env.GITHUB_REF = 'refs/heads/one';
      const first = host.context().refs.current;
      process.env.GITHUB_REF = 'refs/heads/two';
      expect(first).toBe('refs/heads/one');
      expect(host.context().refs.current).toBe('refs/heads/two');
    } finally {
      if (saved === undefined) {
        delete process.env.GITHUB_REF;
      } else {
        process.env.GITHUB_REF = saved;
      }
    }
  });

  it('homeDir falls back to USERPROFILE', () => {
    const host = new GitHubActionsHost({ USERPROFILE: 'C:\\Users\\r' });
    expect(host.context().homeDir).toBe('C:\\Users\\r');
  });

  it('homeDir prefers HOME', () => {
    const host = new GitHubActionsHost({ HOME: '/home/r', USERPROFILE: 'C:\\Users\\r' });
    expect(host.context().homeDir).toBe('/home/r');
  });

  it('input passes options through', () => {
    coreMock.getInput.mockReturnValue('v');
    const host = new GitHubActionsHost({});
    expect(host.input('key', { required: true })).toBe('v');
    expect(coreMock.getInput).toHaveBeenCalledWith('key', { required: true });
  });

  it('setFailed delegates to core.setFailed', () => {
    new GitHubActionsHost({}).setFailed('boom');
    expect(coreMock.setFailed).toHaveBeenCalledWith('boom');
  });

  it('setOutput delegates to core.setOutput', () => {
    new GitHubActionsHost({}).setOutput('cache-hit', true);
    expect(coreMock.setOutput).toHaveBeenCalledWith('cache-hit', true);
  });

  it('log methods delegate to the matching core function', () => {
    const { log: hostLog } = new GitHubActionsHost({});
    hostLog.debug('d');
    hostLog.info('i');
    hostLog.warning('w');
    hostLog.error('e');
    hostLog.startGroup('g');
    hostLog.endGroup();
    expect(coreMock.debug).toHaveBeenCalledWith('d');
    expect(coreMock.info).toHaveBeenCalledWith('i');
    expect(coreMock.warning).toHaveBeenCalledWith('w');
    expect(coreMock.error).toHaveBeenCalledWith('e');
    expect(coreMock.startGroup).toHaveBeenCalledWith('g');
    expect(coreMock.endGroup).toHaveBeenCalledTimes(1);
  });

  it('summary is undefined without GITHUB_STEP_SUMMARY', () => {
    expect(new GitHubActionsHost({}).summary).toBeUndefined();
  });

  it('summary wraps core.summary with GITHUB_STEP_SUMMARY', () => {
    const host = new GitHubActionsHost({ GITHUB_STEP_SUMMARY: '/s' });
    expect(host.summary).toBe(summaryMock);
  });
});

describe('getHost and setHost', () => {
  it('getHost returns a GitHubActionsHost by default; setHost(undefined) resets it', () => {
    const first = getHost();
    expect(first).toBeInstanceOf(GitHubActionsHost);
    expect(getHost()).toBe(first);
    const custom = new GitHubActionsHost({});
    setHost(custom);
    expect(getHost()).toBe(custom);
    setHost(undefined);
    expect(getHost()).not.toBe(custom);
    expect(getHost()).toBeInstanceOf(GitHubActionsHost);
  });

  it('log sends each call to the active host', () => {
    log.info('hello');
    expect(coreMock.info).toHaveBeenCalledWith('hello');
  });
});

describe('job summary through the host', () => {
  it('no summary writer, no summary', async () => {
    const { writeRestoreSummary } = await import('../../../src/core/summary');
    const previous = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = '/tmp/summary-not-used';
    try {
      // A real host object: the prototype keeps context(), input() and the other methods.
      const host = Object.assign(
        Object.create(GitHubActionsHost.prototype),
        new GitHubActionsHost({})
      );
      Object.defineProperty(host, 'summary', { value: undefined });
      setHost(host);
      await expect(
        writeRestoreSummary({
          jobSummary: true,
          primaryKey: 'k',
          cacheHit: false,
          source: 'none',
          durationMs: 1,
        })
      ).resolves.toBeUndefined();
      expect(summaryMock.addHeading).not.toHaveBeenCalled();
      expect(summaryMock.write).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = previous;
    }
  });
});
