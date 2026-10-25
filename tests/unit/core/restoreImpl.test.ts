import { jest } from '@jest/globals';
import { Inputs, State } from '../../../src/constants';
import type { RestoreOutcome } from '../../../src/core/outcomes';
import type { StepMetrics } from '../../../src/core/metrics';
import type { S3Tier } from '../../../src/core/s3Tier';
import { MemoryState } from '../../support/memoryState';
import { makeTempDir, removeDir, setEnv, writeFiles } from '../../support/tempTree';

const inputs = new Map<string, string>();
const outputs = new Map<string, string>();
const mockSetFailed = jest.fn<(message: string) => void>();
const mockWarning = jest.fn<(message: string) => void>();
const mockBuildS3Tier = jest.fn<(config: unknown) => Promise<S3Tier>>();
const mockRestoreFromS3 =
  jest.fn<
    (
      tier: S3Tier,
      primaryKey: string,
      restoreKeys: readonly string[],
      lookupOnly: boolean
    ) => Promise<RestoreOutcome>
  >();
const mockRestoreFromGitHub =
  jest.fn<
    (
      paths: readonly string[],
      primaryKey: string,
      restoreKeys: readonly string[],
      lookupOnly: boolean,
      crossOs: boolean
    ) => Promise<RestoreOutcome>
  >();
const mockStartGroup = jest.fn<(name: string) => void>();
const mockEndGroup = jest.fn<() => void>();
const mockCoreInfo = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  setOutput: (name: string, value: string) => {
    outputs.set(name, value);
  },
  setFailed: mockSetFailed,
  info: mockCoreInfo,
  warning: mockWarning,
  debug: jest.fn(),
  saveState: jest.fn(),
  getState: () => '',
  startGroup: mockStartGroup,
  endGroup: mockEndGroup,
}));
jest.unstable_mockModule('../../../src/core/s3Tier', () => ({
  buildS3Tier: mockBuildS3Tier,
  restoreFromS3: mockRestoreFromS3,
}));
jest.unstable_mockModule('../../../src/core/githubTier', () => ({
  restoreFromGitHub: mockRestoreFromGitHub,
}));
const mockWriteRestoreSummary = jest.fn<(data: unknown) => Promise<void>>();
jest.unstable_mockModule('../../../src/core/summary', () => ({
  writeRestoreSummary: mockWriteRestoreSummary,
}));
const mockBuildExplainReport = jest.fn<(tier: unknown, config: unknown) => Promise<unknown>>();
const mockRenderExplain = jest.fn<(report: unknown) => string[]>();
const mockWriteExplainSummary = jest.fn<(report: unknown, jobSummary: boolean) => Promise<void>>();
jest.unstable_mockModule('../../../src/core/explain', () => ({
  buildExplainReport: mockBuildExplainReport,
  renderExplain: mockRenderExplain,
  writeExplainSummary: mockWriteExplainSummary,
}));
const mockEmitMetrics =
  jest.fn<(metrics: StepMetrics, metricsFile: string, workspace: string) => void>();
const mockHostMetricsFields =
  jest.fn<(compression?: string, region?: string) => Partial<StepMetrics>>();
jest.unstable_mockModule('../../../src/core/metrics', () => ({
  emitMetrics: mockEmitMetrics,
  hostMetricsFields: mockHostMetricsFields,
}));

const { restoreImpl, runRestore, runRestoreOnly } = await import('../../../src/core/restoreImpl');

const tier = {
  storage: { providerConfig: { provider: 'seaweedfs', region: 'eu-west-1' } },
  compression: { method: 'zstd', archiveFilename: 'cache.tar.zst' },
} as unknown as S3Tier;
const s3Hit = (matchedKey: string, exact: boolean): RestoreOutcome => ({
  kind: 'hit',
  matchedKey,
  exact,
  s3: { objectKey: `octo/app/${matchedKey}/cache.tar.zst`, size: 2048, etag: '"etag"' },
  transferMs: 7,
});
const githubHit = (matchedKey: string, exact: boolean): RestoreOutcome => ({
  kind: 'hit',
  matchedKey,
  exact,
});
const miss: RestoreOutcome = { kind: 'miss' };
const failure = (message: string): RestoreOutcome => ({ kind: 'error', error: new Error(message) });

describe('restoreImpl', () => {
  let state: MemoryState;

  beforeEach(() => {
    inputs.clear();
    outputs.clear();
    jest.clearAllMocks();
    state = new MemoryState();
    mockHostMetricsFields.mockReturnValue({});
    process.env.GITHUB_EVENT_NAME = 'push';
    inputs.set(Inputs.Key, 'Linux-npm-abc');
    inputs.set(Inputs.Path, '~/.npm');
    inputs.set(Inputs.RestoreKeys, 'Linux-npm-');
    mockBuildS3Tier.mockResolvedValue(tier);
    mockRestoreFromS3.mockResolvedValue(miss);
    mockRestoreFromGitHub.mockResolvedValue(miss);
    mockBuildExplainReport.mockResolvedValue({});
    mockRenderExplain.mockReturnValue(['line one', 'line two']);
    mockWriteExplainSummary.mockResolvedValue(undefined);
  });

  it('restores an exact S3 hit and records it for the post step', async () => {
    mockRestoreFromS3.mockResolvedValue(s3Hit('Linux-npm-abc', true));

    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');

    expect(mockRestoreFromS3).toHaveBeenCalledWith(tier, 'Linux-npm-abc', ['Linux-npm-'], false);
    expect(Object.fromEntries(outputs)).toEqual({
      'cache-primary-key': 'Linux-npm-abc',
      'cache-hit': 'true',
      'cache-hit-source': 's3',
      'cache-matched-key': 'Linux-npm-abc',
      'cache-storage-provider': 'seaweedfs',
      'cache-s3-key': 'octo/app/Linux-npm-abc/cache.tar.zst',
      'cache-size': '2048',
      'cache-etag': '"etag"',
      'cache-metadata': '{}',
      'cache-restore-duration-ms': expect.stringMatching(/^\d+$/) as unknown as string,
      'cache-transfer-duration-ms': '7',
      'cache-bytes': '2048',
    });
    expect(state.values.get(State.CacheS3ExactHit)).toBe('true');
    expect(state.values.get(State.CacheMatchedKey)).toBe('Linux-npm-abc');
    expect(state.values.get(State.CacheHitSource)).toBe('s3');
    expect(mockRestoreFromGitHub).not.toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockWriteRestoreSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        jobSummary: true,
        primaryKey: 'Linux-npm-abc',
        matchedKey: 'Linux-npm-abc',
        cacheHit: true,
        source: 's3',
        size: 2048,
      })
    );
  });

  it('reports a partial hit as cache-hit false', async () => {
    mockRestoreFromS3.mockResolvedValue(s3Hit('Linux-npm-old', false));
    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-old');
    expect(outputs.get('cache-hit')).toBe('false');
    expect(outputs.get('cache-matched-key')).toBe('Linux-npm-old');
    expect(state.values.has(State.CacheS3ExactHit)).toBe(false);
  });

  it('persists the configuration the post step needs', async () => {
    inputs.set(Inputs.RetryCount, '0');
    inputs.set(Inputs.ScopedToRef, 'false');
    await restoreImpl(state, false);
    expect(state.values.get(State.CachePrimaryKey)).toBe('Linux-npm-abc');
    expect(state.values.get(State.CacheRetryCount)).toBe('0');
    expect(state.values.get(State.CacheScopedToRef)).toBe('false');
    expect(state.values.get(State.CacheStorageProvider)).toBe('seaweedfs');
    expect(state.values.get(State.CacheCompression)).toBe('zstd');
  });

  it('outputs cache-metadata as JSON on an S3 hit and {} otherwise', async () => {
    mockRestoreFromS3.mockResolvedValueOnce({
      kind: 'hit',
      matchedKey: 'Linux-npm-abc',
      exact: true,
      s3: { objectKey: 'octo/app/Linux-npm-abc/cache.tar.zst', size: 1, metadata: { team: 'x' } },
    });
    await restoreImpl(state, false);
    expect(outputs.get('cache-metadata')).toBe('{"team":"x"}');
  });

  it('sets cache-metadata to {} on a miss', async () => {
    mockRestoreFromS3.mockResolvedValueOnce({ kind: 'miss' });
    await restoreImpl(state, false);
    expect(outputs.get('cache-metadata')).toBe('{}');
  });

  it('passes lookup-only through', async () => {
    inputs.set(Inputs.LookupOnly, 'true');
    await restoreImpl(state, false);
    expect(mockRestoreFromS3).toHaveBeenCalledWith(tier, 'Linux-npm-abc', ['Linux-npm-'], true);
  });

  it('logs no timing line on a lookup-only hit, which downloads nothing', async () => {
    inputs.set(Inputs.LookupOnly, 'true');
    mockRestoreFromS3.mockResolvedValue({
      kind: 'hit',
      matchedKey: 'Linux-npm-abc',
      exact: true,
      lookupMs: 30,
    });
    await restoreImpl(state, false);
    expect(mockCoreInfo.mock.calls.some(([line]) => line.startsWith('Timings: '))).toBe(false);
  });

  it('treats an S3 restore failure as a miss with a warning instead of failing the step', async () => {
    mockRestoreFromS3.mockResolvedValue(failure('download interrupted'));
    await expect(restoreImpl(state, false)).resolves.toBeUndefined();
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('download interrupted'));
    expect(outputs.get('cache-hit')).toBe('false');
    expect(outputs.get('cache-hit-source')).toBe('none');
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockWriteRestoreSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        jobSummary: true,
        primaryKey: 'Linux-npm-abc',
        matchedKey: undefined,
        cacheHit: false,
        source: 'none',
        size: undefined,
      })
    );
  });

  it('says no cache was restored, not "Cache not found", after an S3 tier error', async () => {
    mockRestoreFromS3.mockResolvedValue(failure('Please reduce your request rate.'));
    await restoreImpl(state, false);
    expect(mockCoreInfo).toHaveBeenCalledWith(
      'No cache restored: the s3 tier failed (see the warning above). Keys searched: Linux-npm-abc, Linux-npm-'
    );
    expect(mockCoreInfo).not.toHaveBeenCalledWith(expect.stringContaining('Cache not found'));
  });

  it('names every tier that failed in non-strict dual-cache mode', async () => {
    inputs.set(Inputs.DualCache, 'true');
    mockRestoreFromS3.mockResolvedValue(failure('AccessDenied'));
    mockRestoreFromGitHub.mockResolvedValue(failure('Cache Service Url not found'));
    await restoreImpl(state, false);
    expect(mockCoreInfo).toHaveBeenCalledWith(
      'No cache restored: the s3 and github tiers failed (see the warnings above). Keys searched: Linux-npm-abc, Linux-npm-'
    );
  });

  it('keeps the actions/cache text for a true miss', async () => {
    await restoreImpl(state, false);
    expect(mockCoreInfo).toHaveBeenCalledWith(
      'Cache not found for input keys: Linux-npm-abc, Linux-npm-'
    );
  });

  it('passes job-summary through to the summary writer', async () => {
    inputs.set(Inputs.JobSummary, 'false');
    await restoreImpl(state, false);
    expect(mockWriteRestoreSummary).toHaveBeenCalledWith(
      expect.objectContaining({ jobSummary: false })
    );
  });

  it('fails on a miss when fail-on-cache-miss is set', async () => {
    inputs.set(Inputs.FailOnCacheMiss, 'true');
    await restoreImpl(state, false);
    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('fail-on-cache-miss'));
  });

  it('asks GitHub only when use-fallback is set', async () => {
    await restoreImpl(state, false);
    expect(mockRestoreFromGitHub).not.toHaveBeenCalled();

    inputs.set(Inputs.UseFallback, 'true');
    mockRestoreFromGitHub.mockResolvedValue(githubHit('Linux-npm-abc', true));
    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');
    expect(mockRestoreFromGitHub).toHaveBeenCalledWith(
      ['~/.npm'],
      'Linux-npm-abc',
      ['Linux-npm-'],
      false,
      false
    );
    expect(outputs.get('cache-hit-source')).toBe('github');
    expect(state.values.get(State.CacheGithubExactHit)).toBe('true');
    expect(state.values.has(State.CacheS3ExactHit)).toBe(false);
  });

  it('fails when S3 cannot be set up and no other tier can serve the restore', async () => {
    mockBuildS3Tier.mockRejectedValue(new Error('Bucket name is required.'));
    await restoreImpl(state, false);
    expect(mockSetFailed).toHaveBeenCalledWith('Bucket name is required.');
  });

  it('continues with GitHub when S3 setup fails in non-strict dual-cache mode', async () => {
    inputs.set(Inputs.DualCache, 'true');
    mockBuildS3Tier.mockRejectedValue(new Error('Bucket name is required.'));
    mockRestoreFromGitHub.mockResolvedValue(githubHit('Linux-npm-abc', true));
    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('S3 client initialization failed')
    );
    expect(mockRestoreFromS3).not.toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('stops at an S3 hit in s3-first dual-cache mode', async () => {
    inputs.set(Inputs.DualCache, 'true');
    mockRestoreFromS3.mockResolvedValue(s3Hit('Linux-npm-abc', true));
    await restoreImpl(state, false);
    expect(mockRestoreFromGitHub).not.toHaveBeenCalled();
  });

  it('asks GitHub first, then S3, in github-first dual-cache mode', async () => {
    inputs.set(Inputs.DualCache, 'true');
    inputs.set(Inputs.RestorePriority, 'github-first');
    mockRestoreFromS3.mockResolvedValue(s3Hit('Linux-npm-abc', true));
    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');
    expect(mockRestoreFromGitHub.mock.invocationCallOrder[0]).toBeLessThan(
      mockRestoreFromS3.mock.invocationCallOrder[0]
    );
    expect(outputs.get('cache-hit-source')).toBe('s3');
  });

  it('warns and moves on to GitHub after an S3 error in non-strict dual-cache mode', async () => {
    inputs.set(Inputs.DualCache, 'true');
    mockRestoreFromS3.mockResolvedValue(failure('AccessDenied'));
    mockRestoreFromGitHub.mockResolvedValue(githubHit('Linux-npm-abc', true));
    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('AccessDenied'));
  });

  it('fails the step on an S3 error in strict dual-cache mode', async () => {
    inputs.set(Inputs.DualCache, 'true');
    inputs.set(Inputs.DualCacheStrict, 'true');
    mockRestoreFromS3.mockResolvedValue(failure('AccessDenied'));
    await restoreImpl(state, false);
    expect(mockSetFailed).toHaveBeenCalledWith('Restoring from s3 failed: AccessDenied');
    expect(mockRestoreFromGitHub).not.toHaveBeenCalled();
  });

  it('fails the step on a GitHub error in strict dual-cache mode', async () => {
    inputs.set(Inputs.DualCache, 'true');
    inputs.set(Inputs.DualCacheStrict, 'true');
    inputs.set(Inputs.RestorePriority, 'github-first');
    mockRestoreFromGitHub.mockResolvedValue(failure('Cache service responded with 503'));
    await expect(restoreImpl(state, false)).resolves.toBeUndefined();
    expect(mockSetFailed).toHaveBeenCalledWith(
      'Restoring from github failed: Cache service responded with 503'
    );
    expect(mockRestoreFromS3).not.toHaveBeenCalled();
  });

  it('fails when the key input is missing and no preset is set', async () => {
    inputs.delete(Inputs.Key);
    await restoreImpl(state, false);
    expect(mockSetFailed).toHaveBeenCalledWith(
      'Input required and not supplied: key. Set key and path, or set preset.'
    );
    expect(mockWriteRestoreSummary).not.toHaveBeenCalled();
  });

  it('fails when the path input is missing and no preset is set', async () => {
    inputs.delete(Inputs.Path);
    await restoreImpl(state, false);
    expect(mockSetFailed).toHaveBeenCalledWith(
      'Input required and not supplied: path. Set key and path, or set preset.'
    );
  });

  describe('with a preset', () => {
    let workspace: string;
    let restoreEnv: () => void;

    beforeEach(() => {
      workspace = makeTempDir('restore-preset');
      restoreEnv = setEnv({ GITHUB_WORKSPACE: workspace, RUNNER_OS: 'Linux' });
      inputs.delete(Inputs.Key);
      inputs.delete(Inputs.Path);
      inputs.delete(Inputs.RestoreKeys);
      inputs.set(Inputs.Preset, 'npm');
    });

    afterEach(() => {
      restoreEnv();
      removeDir(workspace);
    });

    it('resolves the path, key and restore-keys, and persists them for the post step', async () => {
      writeFiles(workspace, { 'package-lock.json': '{}' });
      await restoreImpl(state, false);

      expect(mockSetFailed).not.toHaveBeenCalled();
      const [, key, restoreKeys] = mockRestoreFromS3.mock.calls[0];
      expect(key).toMatch(/^Linux-npm-[0-9a-f]{64}$/);
      expect(restoreKeys).toEqual(['Linux-npm-']);
      expect(outputs.get('cache-primary-key')).toBe(key);
      expect(state.getState(State.CachePrimaryKey)).toBe(key);
      expect(JSON.parse(state.getState(State.CachePaths))).toEqual(['~/.npm']);
      expect(mockBuildS3Tier).toHaveBeenCalledWith(
        expect.objectContaining({ paths: ['~/.npm'], preset: 'npm' })
      );
      expect(mockWriteRestoreSummary).toHaveBeenCalledWith(
        expect.objectContaining({ primaryKey: key, preset: 'npm', paths: ['~/.npm'] })
      );
    });

    it('fails and names the globs when no lockfile is found', async () => {
      await restoreImpl(state, false);
      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining('It looked for: **/package-lock.json, **/npm-shrinkwrap.json.')
      );
      expect(mockRestoreFromS3).not.toHaveBeenCalled();
    });

    it('fails on an unknown preset', async () => {
      inputs.set(Inputs.Preset, 'npmx');
      await restoreImpl(state, false);
      expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining('Input "preset" must be'));
    });
  });

  it('logs the explain report before restoring, without changing the outcome', async () => {
    inputs.set(Inputs.Explain, 'true');
    mockRestoreFromS3.mockResolvedValue(s3Hit('Linux-npm-abc', true));

    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');

    expect(mockBuildExplainReport).toHaveBeenCalledWith(
      tier,
      expect.objectContaining({
        primaryKey: 'Linux-npm-abc',
      })
    );
    expect(mockStartGroup).toHaveBeenCalledWith('Cache lookup explained');
    expect(mockCoreInfo).toHaveBeenCalledWith('line one');
    expect(mockCoreInfo).toHaveBeenCalledWith('line two');
    expect(mockEndGroup).toHaveBeenCalled();
    expect(mockWriteExplainSummary).toHaveBeenCalledWith({}, true);
    const explainOrder = mockBuildExplainReport.mock.invocationCallOrder[0];
    const restoreOrder = mockRestoreFromS3.mock.invocationCallOrder[0];
    expect(explainOrder).toBeLessThan(restoreOrder);
  });

  it('does not explain by default', async () => {
    await restoreImpl(state, false);
    expect(mockBuildExplainReport).not.toHaveBeenCalled();
    expect(mockStartGroup).not.toHaveBeenCalled();
  });

  it('warns once and still restores when the explain report throws', async () => {
    inputs.set(Inputs.Explain, 'true');
    mockBuildExplainReport.mockRejectedValue(new Error('boom'));
    mockRestoreFromS3.mockResolvedValue(s3Hit('Linux-npm-abc', true));

    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');

    expect(mockWarning).toHaveBeenCalledWith('Could not explain the cache lookup: boom');
    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockStartGroup).not.toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('closes the log group and warns once when rendering the explain report throws', async () => {
    inputs.set(Inputs.Explain, 'true');
    mockRenderExplain.mockImplementation(() => {
      throw new Error('render boom');
    });
    mockRestoreFromS3.mockResolvedValue(s3Hit('Linux-npm-abc', true));

    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');

    expect(mockStartGroup).toHaveBeenCalledWith('Cache lookup explained');
    expect(mockEndGroup).toHaveBeenCalledTimes(1);
    expect(mockWarning).toHaveBeenCalledWith('Could not explain the cache lookup: render boom');
    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it('does not explain when S3 setup failed and no S3 tier is available', async () => {
    inputs.set(Inputs.Explain, 'true');
    inputs.set(Inputs.DualCache, 'true');
    mockBuildS3Tier.mockRejectedValue(new Error('Bucket name is required.'));
    mockRestoreFromGitHub.mockResolvedValue(githubHit('Linux-npm-abc', true));

    await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');

    expect(mockBuildExplainReport).not.toHaveBeenCalled();
  });

  it('does not persist the explain input for the post step', async () => {
    inputs.set(Inputs.Explain, 'true');
    await restoreImpl(state, false);
    expect([...state.values.keys()].some((key) => key.includes('EXPLAIN'))).toBe(false);
  });

  it('reports the timing and size outputs on a hit and emits its metrics', async () => {
    mockRestoreFromS3.mockResolvedValue(s3Hit('Linux-npm-abc', true));
    inputs.set(Inputs.MetricsFile, 'metrics.jsonl');

    await restoreImpl(state, false);

    expect(outputs.get('cache-restore-duration-ms')).toMatch(/^\d+$/);
    expect(outputs.get('cache-transfer-duration-ms')).toBe('7');
    expect(outputs.get('cache-bytes')).toBe('2048');
    expect(state.values.get(State.CacheMetricsFile)).toBe('metrics.jsonl');
    expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
    const [metrics, metricsFile] = mockEmitMetrics.mock.calls[0];
    expect(metricsFile).toBe('metrics.jsonl');
    expect(metrics).toEqual(
      expect.objectContaining({
        step: 'restore',
        outcome: 'hit',
        provider: 'seaweedfs',
        key: 'Linux-npm-abc',
        matchedKey: 'Linux-npm-abc',
        objectKey: 'octo/app/Linux-npm-abc/cache.tar.zst',
        source: 's3',
        bytes: 2048,
        transferDurationMs: 7,
      })
    );
    expect(metrics.durationMs).toEqual(expect.any(Number));
    expect(metrics.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes the phase times to the metrics and logs one timing line on a hit', async () => {
    mockRestoreFromS3.mockResolvedValue({
      ...s3Hit('Linux-npm-abc', true),
      lookupMs: 30,
      extractMs: 40,
    } as RestoreOutcome);

    await restoreImpl(state, false);

    const [metrics] = mockEmitMetrics.mock.calls[0];
    expect(metrics).toEqual(
      expect.objectContaining({
        lookupDurationMs: 30,
        transferDurationMs: 7,
        extractDurationMs: 40,
      })
    );
    const timingLines = mockCoreInfo.mock.calls.filter(([line]) => line.startsWith('Timings: '));
    expect(timingLines).toHaveLength(1);
    expect(timingLines[0][0]).toMatch(
      /^Timings: lookup 0\.03 s, download 0\.01 s \(.+ MiB\/s\), extract 0\.04 s, total \d+\.\d{2} s$/
    );
  });

  it('logs no timing line on a miss', async () => {
    await restoreImpl(state, false);
    expect(mockCoreInfo.mock.calls.some(([line]) => line.startsWith('Timings: '))).toBe(false);
  });

  it('reports zero bytes and zero transfer time on a miss', async () => {
    await restoreImpl(state, false);
    expect(outputs.get('cache-bytes')).toBe('0');
    expect(outputs.get('cache-transfer-duration-ms')).toBe('0');
    expect(outputs.get('cache-restore-duration-ms')).toMatch(/^\d+$/);
    expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
    expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
      expect.objectContaining({ step: 'restore', outcome: 'miss', bytes: 0, source: 'none' })
    );
  });

  it('emits error metrics and keeps the zeroed outputs when the step fails', async () => {
    inputs.set(Inputs.MetricsFile, 'metrics.jsonl');
    mockBuildS3Tier.mockRejectedValue(new Error('no credentials'));

    await restoreImpl(state, false);

    expect(mockSetFailed).toHaveBeenCalledWith('no credentials');
    expect(outputs.get('cache-bytes')).toBe('0');
    expect(outputs.get('cache-restore-duration-ms')).toBe('0');
    expect(outputs.get('cache-transfer-duration-ms')).toBe('0');
    expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
    expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
      expect.objectContaining({ step: 'restore', outcome: 'error', bytes: 0 })
    );
    expect(mockEmitMetrics.mock.calls[0][1]).toBe('metrics.jsonl');
  });

  describe('ACTIONS_CACHE_MODE', () => {
    let restoreEnv: () => void = () => {};

    afterEach(() => {
      restoreEnv();
      restoreEnv = () => {};
    });

    const useMode = (mode: string | undefined): void => {
      restoreEnv = setEnv({ ACTIONS_CACHE_MODE: mode });
    };

    it.each(['none', 'write-only', ' NONE ', 'Write-Only'])(
      'skips the restore on both tiers when the mode is %p',
      async (mode) => {
        useMode(mode);
        inputs.set(Inputs.DualCache, 'true');
        inputs.set(Inputs.MetricsFile, 'metrics.jsonl');

        await expect(restoreImpl(state, false)).resolves.toBeUndefined();

        const effective = mode.trim().toLowerCase();
        expect(mockBuildS3Tier).not.toHaveBeenCalled();
        expect(mockRestoreFromS3).not.toHaveBeenCalled();
        expect(mockRestoreFromGitHub).not.toHaveBeenCalled();
        expect(mockSetFailed).not.toHaveBeenCalled();
        expect(mockWarning).not.toHaveBeenCalled();
        expect(mockCoreInfo).toHaveBeenCalledWith(
          `Cache restore skipped: ACTIONS_CACHE_MODE is '${effective}', which does not permit reads.`
        );
        expect(outputs.get('cache-hit')).toBe('false');
        expect(outputs.get('cache-hit-source')).toBe('none');
        expect(outputs.get('cache-primary-key')).toBe('Linux-npm-abc');
        expect(outputs.get('cache-bytes')).toBe('0');
        expect(state.values.get(State.CacheHitSource)).toBe('none');
        expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
        expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
          expect.objectContaining({
            step: 'restore',
            outcome: 'skipped',
            source: 'none',
            bytes: 0,
            extra: { reason: `ACTIONS_CACHE_MODE=${effective}` },
          })
        );
        expect(mockWriteRestoreSummary).toHaveBeenCalledWith(
          expect.objectContaining({
            cacheHit: false,
            source: 'none',
            skipped: `ACTIONS_CACHE_MODE is ${effective}`,
          })
        );
      }
    );

    it.each([undefined, '', 'read', 'write', 'READ', 'readonly', 'off'])(
      'restores as usual when the mode is %p',
      async (mode) => {
        useMode(mode);
        mockRestoreFromS3.mockResolvedValue(s3Hit('Linux-npm-abc', true));

        await expect(restoreImpl(state, false)).resolves.toBe('Linux-npm-abc');

        expect(mockRestoreFromS3).toHaveBeenCalled();
        expect(mockCoreInfo).not.toHaveBeenCalledWith(
          expect.stringContaining('ACTIONS_CACHE_MODE')
        );
      }
    );

    it('does not fail a skipped restore in strict dual-cache mode', async () => {
      useMode('none');
      inputs.set(Inputs.DualCache, 'true');
      inputs.set(Inputs.DualCacheStrict, 'true');

      await restoreImpl(state, false);

      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockRestoreFromS3).not.toHaveBeenCalled();
      expect(mockRestoreFromGitHub).not.toHaveBeenCalled();
    });

    it('fails a skipped restore when fail-on-cache-miss is set, as actions/cache does', async () => {
      useMode('write-only');
      inputs.set(Inputs.FailOnCacheMiss, 'true');

      await restoreImpl(state, false);

      expect(mockSetFailed).toHaveBeenCalledWith(
        'Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: Linux-npm-abc'
      );
      expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
      expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
        expect.objectContaining({ outcome: 'skipped' })
      );
    });

    it('skips the restore in write-only mode also when read-only is set', async () => {
      useMode('write-only');
      inputs.set(Inputs.ReadOnly, 'true');

      await restoreImpl(state, false);

      expect(mockRestoreFromS3).not.toHaveBeenCalled();
    });

    it('restores in read mode when read-only is set', async () => {
      useMode('read');
      inputs.set(Inputs.ReadOnly, 'true');

      await restoreImpl(state, false);

      expect(mockRestoreFromS3).toHaveBeenCalled();
    });
  });

  it('runs the wrappers without exiting when earlyExit is false', async () => {
    await expect(runRestore(false)).resolves.toBeUndefined();
    await expect(runRestoreOnly(false)).resolves.toBeUndefined();
  });

  it('exits 0 from the wrappers after a restore that did not fail', async () => {
    const exitCodes: Array<string | number | null | undefined> = [];
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null
    ) => {
      exitCodes.push(code);
    }) as (code?: string | number | null) => never);
    try {
      await runRestore(true);
      await runRestoreOnly(true);
    } finally {
      exitSpy.mockRestore();
    }
    expect(exitCodes).toEqual([0, 0]);
  });

  it('adds the host fields, with the compression and region of the S3 tier, to the metrics', async () => {
    mockHostMetricsFields.mockReturnValue({ platform: 'bitbucket' });

    await restoreImpl(state, false);

    expect(mockHostMetricsFields).toHaveBeenCalledWith('zstd', 'eu-west-1');
    expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
      expect.objectContaining({ step: 'restore', platform: 'bitbucket', outcome: 'miss' })
    );
  });

  it('leaves the compression and region out when the S3 tier is not built', async () => {
    mockBuildS3Tier.mockRejectedValue(new Error('no client'));

    await restoreImpl(state, false);

    expect(mockHostMetricsFields).toHaveBeenLastCalledWith(undefined, undefined);
  });
});
