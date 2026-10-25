import { jest } from '@jest/globals';
import { Inputs, State } from '../../../src/constants';
import type { SaveOutcome } from '../../../src/core/outcomes';
import type { StepMetrics } from '../../../src/core/metrics';
import type { S3Tier } from '../../../src/core/s3Tier';
import { annotateS3Error } from '../../../src/storage/errors';
import { MemoryState } from '../../support/memoryState';
import { makeTempDir, removeDir, setEnv, writeFiles } from '../../support/tempTree';

const inputs = new Map<string, string>();
const outputs = new Map<string, string>();
// Like the real core.setFailed, which only sets process.exitCode.
const mockSetFailed = jest.fn<(message: string) => void>(() => {
  process.exitCode = 1;
});
const mockWarning = jest.fn<(message: string) => void>();
const mockInfo = jest.fn<(message: string) => void>();
const mockSetOutput = jest.fn<(name: string, value: string) => void>((name, value) => {
  outputs.set(name, value);
});
const mockBuildS3Tier =
  jest.fn<
    (
      config: unknown,
      env?: NodeJS.ProcessEnv,
      options?: { compression?: string }
    ) => Promise<S3Tier>
  >();
const mockSaveToS3 =
  jest.fn<
    (
      tier: S3Tier,
      primaryKey: string,
      patterns: readonly string[],
      chunkSize?: number
    ) => Promise<SaveOutcome>
  >();
const mockExistsInGitHub =
  jest.fn<(paths: readonly string[], key: string, crossOs: boolean) => Promise<boolean>>();
const mockSaveToGitHub =
  jest.fn<
    (
      paths: readonly string[],
      key: string,
      chunkSize: number | undefined,
      crossOs: boolean
    ) => Promise<SaveOutcome>
  >();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  warning: mockWarning,
  debug: jest.fn(),
  saveState: jest.fn(),
  getState: () => '',
}));
jest.unstable_mockModule('../../../src/core/s3Tier', () => ({
  buildS3Tier: mockBuildS3Tier,
  saveToS3: mockSaveToS3,
}));
jest.unstable_mockModule('../../../src/core/githubTier', () => ({
  existsInGitHub: mockExistsInGitHub,
  saveToGitHub: mockSaveToGitHub,
}));
const mockWriteSaveSummary = jest.fn<(data: unknown) => Promise<void>>();
jest.unstable_mockModule('../../../src/core/summary', () => ({
  writeSaveSummary: mockWriteSaveSummary,
}));
const mockEmitMetrics =
  jest.fn<(metrics: StepMetrics, metricsFile: string, workspace: string) => void>();
const mockHostMetricsFields =
  jest.fn<(compression?: string, region?: string) => Partial<StepMetrics>>();
jest.unstable_mockModule('../../../src/core/metrics', () => ({
  emitMetrics: mockEmitMetrics,
  hostMetricsFields: mockHostMetricsFields,
}));

const { runSave, runSaveOnly, saveImpl } = await import('../../../src/core/saveImpl');

const tier = {
  storage: { providerConfig: { provider: 'seaweedfs', region: 'eu-west-1' } },
  compression: { method: 'gzip', archiveFilename: 'cache.tgz' },
} as unknown as S3Tier;
const s3Info = { objectKey: 'octo/app/k/cache.tar.zst', size: 2048, etag: '"new"' };
const s3Saved: SaveOutcome = { kind: 'saved', s3: s3Info, transferMs: 9 };
const githubSaved: SaveOutcome = { kind: 'saved' };
const githubSkipped: SaveOutcome = {
  kind: 'skipped',
  reason: 'GitHub Actions Cache did not save this key (see the messages above)',
};
const failure = (message: string): SaveOutcome => ({ kind: 'error', error: new Error(message) });

describe('saveImpl', () => {
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
    mockBuildS3Tier.mockResolvedValue(tier);
    mockSaveToS3.mockResolvedValue(s3Saved);
    mockExistsInGitHub.mockResolvedValue(false);
    mockSaveToGitHub.mockResolvedValue(githubSaved);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  describe('metrics', () => {
    it('reports the timing and size outputs and emits the save metrics', async () => {
      inputs.set(Inputs.MetricsFile, 'metrics.jsonl');
      await saveImpl(state);

      expect(outputs.get('cache-save-duration-ms')).toMatch(/^\d+$/);
      expect(outputs.get('cache-transfer-duration-ms')).toBe('9');
      expect(outputs.get('cache-bytes')).toBe('2048');
      expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
      const [metrics, metricsFile] = mockEmitMetrics.mock.calls[0];
      expect(metricsFile).toBe('metrics.jsonl');
      expect(metrics).toEqual(
        expect.objectContaining({
          step: 'save',
          outcome: 'saved',
          provider: 'seaweedfs',
          key: 'Linux-npm-abc',
          objectKey: s3Info.objectKey,
          savedTo: ['s3'],
          bytes: 2048,
          transferDurationMs: 9,
        })
      );
      expect(metrics.durationMs).toEqual(expect.any(Number));
    });

    it('passes the archive time to the metrics and logs one timing line', async () => {
      mockSaveToS3.mockResolvedValue({ ...s3Saved, archiveMs: 20 } as SaveOutcome);
      await saveImpl(state);

      const [metrics] = mockEmitMetrics.mock.calls[0];
      expect(metrics).toEqual(
        expect.objectContaining({ archiveDurationMs: 20, transferDurationMs: 9 })
      );
      const timingLines = mockInfo.mock.calls.filter(([line]) => line.startsWith('Timings: '));
      expect(timingLines).toHaveLength(1);
      expect(timingLines[0][0]).toMatch(
        /^Timings: archive 0\.02 s, upload 0\.01 s \(.+ MiB\/s\), total \d+\.\d{2} s$/
      );
    });

    it('reads metrics-file from the state the restore step persisted', async () => {
      state.setState(State.CacheMetricsFile, 'from-state.jsonl');
      await saveImpl(state);
      expect(mockEmitMetrics.mock.calls[0][1]).toBe('from-state.jsonl');
    });

    it('emits error metrics when an S3 save error was warned away rather than thrown', async () => {
      mockSaveToS3.mockResolvedValue(failure('AccessDenied'));
      await saveImpl(state);

      expect(mockWarning).toHaveBeenCalledWith('Failed to save cache to S3: AccessDenied');
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
      expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          step: 'save',
          outcome: 'error',
          savedTo: [],
          bytes: 0,
          extra: { error: 'AccessDenied' },
        })
      );
    });

    it('emits error metrics when a non-strict dual-cache save saved to neither tier', async () => {
      inputs.set(Inputs.DualCache, 'true');
      mockSaveToS3.mockResolvedValue(failure('AccessDenied'));
      mockSaveToGitHub.mockResolvedValue(failure('cache service unavailable'));
      await saveImpl(state);

      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          step: 'save',
          outcome: 'error',
          savedTo: [],
          extra: { error: 'cache service unavailable' },
        })
      );
    });

    it('still reports a save that reached a tier as saved when the other tier only warned', async () => {
      inputs.set(Inputs.DualCache, 'true');
      mockSaveToS3.mockResolvedValue(failure('AccessDenied'));
      await saveImpl(state);

      expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
        expect.objectContaining({ step: 'save', outcome: 'saved', savedTo: ['github'] })
      );
    });

    it('emits one skipped line with the reason, and zeroed outputs, on a read-only save', async () => {
      inputs.set(Inputs.ReadOnly, 'true');
      await saveImpl(state);

      expect(mockSaveToS3).not.toHaveBeenCalled();
      expect(outputs.get('cache-save-duration-ms')).toBe('0');
      expect(outputs.get('cache-transfer-duration-ms')).toBe('0');
      expect(outputs.get('cache-bytes')).toBe('0');
      expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
      expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          step: 'save',
          outcome: 'skipped',
          savedTo: [],
          bytes: 0,
          extra: { reason: 'read-only' },
        })
      );
    });

    it('zeroes the outputs and emits error metrics when the save fails', async () => {
      mockBuildS3Tier.mockRejectedValue(new Error('no credentials'));
      await saveImpl(state);

      expect(outputs.get('cache-save-duration-ms')).toBe('0');
      expect(outputs.get('cache-transfer-duration-ms')).toBe('0');
      expect(outputs.get('cache-bytes')).toBe('0');
      expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
        expect.objectContaining({ step: 'save', outcome: 'error', bytes: 0 })
      );
    });
  });

  describe('pure S3 mode', () => {
    it('saves to S3 and reports the object', async () => {
      await expect(saveImpl(state)).resolves.toBe(2048);
      expect(mockSaveToS3).toHaveBeenCalledWith(tier, 'Linux-npm-abc', ['~/.npm']);
      expect(Object.fromEntries(outputs)).toEqual({
        'cache-storage-provider': 'seaweedfs',
        'cache-s3-key': s3Info.objectKey,
        'cache-size': '2048',
        'cache-etag': '"new"',
        'cache-saved-sources': 's3',
        'cache-save-duration-ms': expect.stringMatching(/^\d+$/) as unknown as string,
        'cache-transfer-duration-ms': '9',
        'cache-bytes': '2048',
      });
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
      expect(mockWriteSaveSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          jobSummary: true,
          key: 'Linux-npm-abc',
          savedTo: ['s3'],
          size: 2048,
        })
      );
    });

    it('passes job-summary through to the summary writer', async () => {
      inputs.set(Inputs.JobSummary, 'false');
      await saveImpl(state);
      expect(mockWriteSaveSummary).toHaveBeenCalledWith(
        expect.objectContaining({ jobSummary: false })
      );
    });

    it('builds the S3 tier with the compression method the restore step used', async () => {
      state.setState(State.CacheCompression, 'gzip');
      await saveImpl(state);
      expect(mockBuildS3Tier).toHaveBeenCalledWith(expect.anything(), process.env, {
        compression: 'gzip',
      });
    });

    it('skips when the restore step had an exact S3 hit', async () => {
      state.setState(State.CacheS3ExactHit, 'true');
      await saveImpl(state);
      expect(mockSaveToS3).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('none');
      expect(mockWriteSaveSummary).toHaveBeenCalledWith(
        expect.objectContaining({ savedTo: [], size: undefined })
      );
    });

    it('still saves to S3 after an exact hit from the GitHub fallback', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      state.setState(State.CacheGithubExactHit, 'true');
      state.setState(State.CacheMatchedKey, 'Linux-npm-abc');
      await saveImpl(state);
      expect(mockSaveToS3).toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3');
    });

    it('counts an existing object as saved', async () => {
      mockSaveToS3.mockResolvedValue({ kind: 'exists', s3: s3Info });
      await saveImpl(state);
      expect(outputs.get('cache-saved-sources')).toBe('s3');
    });

    it('does not fall back when no paths matched', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      mockSaveToS3.mockResolvedValue({ kind: 'skipped', reason: 'no paths matched' });
      await saveImpl(state);
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('none');
    });

    it('warns without failing when S3 fails and there is no fallback', async () => {
      mockSaveToS3.mockResolvedValue(failure('SlowDown'));
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith('Failed to save cache to S3: SlowDown');
      expect(outputs.get('cache-saved-sources')).toBe('none');
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it('saves to GitHub when S3 fails and use-fallback is set', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      inputs.set(Inputs.EnableCrossOsArchive, 'true');
      mockSaveToS3.mockResolvedValue(failure('SlowDown'));
      await saveImpl(state);
      expect(mockSaveToGitHub).toHaveBeenCalledWith(['~/.npm'], 'Linux-npm-abc', undefined, true);
      expect(outputs.get('cache-saved-sources')).toBe('github');
    });

    it('reports no saved source, without a warning, when the GitHub fallback skips', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      mockSaveToS3.mockResolvedValue(failure('SlowDown'));
      mockSaveToGitHub.mockResolvedValue(githubSkipped);
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledTimes(1);
      expect(mockWarning).toHaveBeenCalledWith('Failed to save cache to S3: SlowDown');
      expect(outputs.get('cache-saved-sources')).toBe('none');
    });

    it('warns without failing when S3 cannot be set up', async () => {
      mockBuildS3Tier.mockRejectedValue(new Error('Bucket name is required.'));
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        'Save cache encountered error: Bucket name is required.'
      );
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it('saves to GitHub when S3 cannot be set up and use-fallback is set', async () => {
      inputs.set(Inputs.UseFallback, 'true');
      mockBuildS3Tier.mockRejectedValue(new Error('Bucket name is required.'));
      await saveImpl(state);
      expect(mockSaveToGitHub).toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('github');
    });

    it('does nothing in read-only mode', async () => {
      state.setState(State.CacheReadOnly, 'true');
      await saveImpl(state);
      expect(mockBuildS3Tier).not.toHaveBeenCalled();
      expect(mockWriteSaveSummary).not.toHaveBeenCalled();
    });

    it('warns and skips when no key is available', async () => {
      inputs.delete(Inputs.Key);
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        'Key is not specified. Set key and path, or set preset. Skipping cache save.'
      );
      expect(mockBuildS3Tier).not.toHaveBeenCalled();
      expect(mockWriteSaveSummary).not.toHaveBeenCalled();
    });
  });

  describe('with a preset', () => {
    let workspace: string;
    let restoreEnv: () => void;

    beforeEach(() => {
      workspace = makeTempDir('save-preset');
      restoreEnv = setEnv({ GITHUB_WORKSPACE: workspace, RUNNER_OS: 'Linux' });
      inputs.delete(Inputs.Key);
      inputs.delete(Inputs.Path);
      inputs.set(Inputs.Preset, 'npm');
    });

    afterEach(() => {
      restoreEnv();
      removeDir(workspace);
    });

    it('reuses the key and paths the restore step resolved, without hashing again', async () => {
      // No lockfile in the workspace: hashing again would fail the save.
      state.setState(State.CachePrimaryKey, 'Linux-npm-fromrestore');
      state.setState(State.CachePaths, JSON.stringify(['~/.npm']));
      await saveImpl(state);
      expect(mockWarning).not.toHaveBeenCalled();
      expect(mockSaveToS3).toHaveBeenCalledWith(tier, 'Linux-npm-fromrestore', ['~/.npm']);
      expect(mockWriteSaveSummary).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'Linux-npm-fromrestore', preset: 'npm' })
      );
    });

    it('hashes the lockfiles when no restore step ran (the save sub-action)', async () => {
      writeFiles(workspace, { 'package-lock.json': '{}' });
      await saveImpl(state);
      const [, key, paths] = mockSaveToS3.mock.calls[0];
      expect(key).toMatch(/^Linux-npm-[0-9a-f]{64}$/);
      expect(paths).toEqual(['~/.npm']);
    });

    it('warns and does not save when no lockfile is found', async () => {
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('Preset "npm" found no lockfile to hash')
      );
      expect(mockSaveToS3).not.toHaveBeenCalled();
    });
  });

  describe('dual-cache mode', () => {
    beforeEach(() => {
      inputs.set(Inputs.DualCache, 'true');
    });

    it('backfills GitHub after an S3 hit once a live check finds the key missing there', async () => {
      state.setState(State.CacheS3ExactHit, 'true');
      await saveImpl(state);
      expect(mockSaveToS3).not.toHaveBeenCalled();
      expect(mockExistsInGitHub).toHaveBeenCalledWith(['~/.npm'], 'Linux-npm-abc', false);
      expect(mockSaveToGitHub).toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3,github');
      expect(mockWriteSaveSummary).toHaveBeenCalledWith(
        expect.objectContaining({ savedTo: ['s3', 'github'] })
      );
    });

    it('does not re-upload to GitHub when the key is already there', async () => {
      mockExistsInGitHub.mockResolvedValue(true);
      await saveImpl(state);
      expect(mockSaveToS3).toHaveBeenCalled();
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3,github');
    });

    it('treats the removed independent strategy as backfill', async () => {
      inputs.set(Inputs.DualCacheStrategy, 'independent');
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        expect.stringContaining('"independent" was removed')
      );
      expect(mockExistsInGitHub).toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3,github');
    });

    it('saves to neither tier after an exact hit with skip-on-hit', async () => {
      inputs.set(Inputs.DualCacheStrategy, 'skip-on-hit');
      state.setState(State.CacheGithubExactHit, 'true');
      await saveImpl(state);
      expect(mockSaveToS3).not.toHaveBeenCalled();
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('github');
    });

    it('warns about an S3 error and still saves to GitHub when not strict', async () => {
      mockSaveToS3.mockResolvedValue(failure('boom'));
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith('Dual-cache S3 save error: boom');
      expect(outputs.get('cache-saved-sources')).toBe('github');
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it('fails the step on an S3 error when strict', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToS3.mockResolvedValue(failure('boom'));
      await saveImpl(state);
      expect(mockSetFailed).toHaveBeenCalledWith('Saving to S3 failed: boom');
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
    });

    it('does not fail or warn in strict mode when GitHub skips the save', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToGitHub.mockResolvedValue(githubSkipped);
      await saveImpl(state);
      expect(mockSaveToGitHub).toHaveBeenCalled();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockWarning).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3');
    });

    it('does not fail the step in strict mode when GitHub skips because no paths matched', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToGitHub.mockResolvedValue({ kind: 'skipped', reason: 'no paths matched' });
      await saveImpl(state);
      expect(mockSaveToGitHub).toHaveBeenCalled();
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('s3');
    });

    it('fails the step on a GitHub save error when strict', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToGitHub.mockResolvedValue(failure('quota exceeded'));
      await saveImpl(state);
      expect(mockSetFailed).toHaveBeenCalledWith(
        'Saving to GitHub Actions Cache failed: quota exceeded'
      );
    });

    it('fails the step when the strict GitHub existence check errors', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockExistsInGitHub.mockRejectedValue(new Error('cache service unavailable'));
      await saveImpl(state);
      expect(mockSetFailed).toHaveBeenCalledWith(
        'Saving to GitHub Actions Cache failed: cache service unavailable'
      );
    });

    it('fails the step when S3 cannot be set up in strict mode', async () => {
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockBuildS3Tier.mockRejectedValue(new Error('Bucket name is required.'));
      await saveImpl(state);
      expect(mockSetFailed).toHaveBeenCalledWith('Bucket name is required.');
    });
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

    it.each(['none', 'read', ' READ ', 'None'])(
      'skips the save on both tiers when the mode is %p',
      async (mode) => {
        useMode(mode);
        inputs.set(Inputs.DualCache, 'true');

        await saveImpl(state);

        const effective = mode.trim().toLowerCase();
        expect(mockBuildS3Tier).not.toHaveBeenCalled();
        expect(mockSaveToS3).not.toHaveBeenCalled();
        expect(mockExistsInGitHub).not.toHaveBeenCalled();
        expect(mockSaveToGitHub).not.toHaveBeenCalled();
        expect(mockSetFailed).not.toHaveBeenCalled();
        expect(mockWarning).not.toHaveBeenCalled();
        expect(mockInfo).toHaveBeenCalledWith(
          `Cache save skipped: ACTIONS_CACHE_MODE is '${effective}', which does not permit writes.`
        );
        expect(outputs.get('cache-saved-sources')).toBe('none');
        expect(outputs.get('cache-bytes')).toBe('0');
        expect(outputs.get('cache-transfer-duration-ms')).toBe('0');
        expect(outputs.get('cache-save-duration-ms')).toMatch(/^\d+$/);
        expect(mockSetOutput).toHaveBeenCalledWith('cache-save-duration-ms', '0');
        expect(mockSetOutput).toHaveBeenLastCalledWith(
          'cache-save-duration-ms',
          expect.stringMatching(/^\d+$/)
        );
        expect(mockEmitMetrics).toHaveBeenCalledTimes(1);
        expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
          expect.objectContaining({
            step: 'save',
            outcome: 'skipped',
            savedTo: [],
            bytes: 0,
            extra: { reason: `ACTIONS_CACHE_MODE=${effective}` },
          })
        );
        expect(mockWriteSaveSummary).toHaveBeenCalledWith(
          expect.objectContaining({ savedTo: [], skipped: `ACTIONS_CACHE_MODE is ${effective}` })
        );
      }
    );

    it.each([undefined, '', 'write', 'write-only', 'WRITE-ONLY', 'readonly', 'off'])(
      'saves as usual when the mode is %p',
      async (mode) => {
        useMode(mode);
        await saveImpl(state);
        expect(mockSaveToS3).toHaveBeenCalled();
        expect(outputs.get('cache-saved-sources')).toBe('s3');
        expect(mockInfo).not.toHaveBeenCalledWith(expect.stringContaining('ACTIONS_CACHE_MODE'));
      }
    );

    it('does not save to the GitHub fallback when the mode skips the save', async () => {
      useMode('none');
      inputs.set(Inputs.UseFallback, 'true');
      await saveImpl(state);
      expect(mockSaveToS3).not.toHaveBeenCalled();
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
    });

    it('does not fail a skipped save in strict dual-cache mode', async () => {
      useMode('read');
      inputs.set(Inputs.DualCache, 'true');
      inputs.set(Inputs.DualCacheStrict, 'true');
      await saveImpl(state);
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(mockSaveToS3).not.toHaveBeenCalled();
      expect(mockSaveToGitHub).not.toHaveBeenCalled();
    });

    it.each(['read', 'write-only', 'write'])(
      'lets read-only skip the save first when the mode is %p',
      async (mode) => {
        useMode(mode);
        inputs.set(Inputs.ReadOnly, 'true');
        await saveImpl(state);
        expect(mockSaveToS3).not.toHaveBeenCalled();
        expect(mockInfo).toHaveBeenCalledWith('Read-only mode enabled. Skipping cache save.');
        expect(mockInfo).not.toHaveBeenCalledWith(expect.stringContaining('ACTIONS_CACHE_MODE'));
        expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
          expect.objectContaining({ outcome: 'skipped', extra: { reason: 'read-only' } })
        );
      }
    );
  });

  describe('access denied on the S3 save', () => {
    const hint =
      'The credentials may not be allowed to write to the bucket. Set read-only: true to skip the save.';
    /** An error as the S3 client gives it for a failed call: the message names the call. */
    const fromCall = <T extends Error>(error: T, operation: string): T => {
      annotateS3Error(error, { operation, bucket: 'b', key: 'k' });
      return error;
    };
    const denied = (): SaveOutcome => ({
      kind: 'error',
      error: fromCall(
        Object.assign(new Error('Access Denied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        }),
        'PutObject'
      ),
    });
    const deniedMessage = (): string => (denied() as { error: Error }).error.message;

    it('warns with the read-only hint and does not fail the step', async () => {
      mockSaveToS3.mockResolvedValue(denied());
      await saveImpl(state);
      expect(deniedMessage()).toMatch(/^PutObject s3:\/\/b\/k returned HTTP 403 Forbidden/);
      expect(mockWarning).toHaveBeenCalledWith(
        `Failed to save cache to S3: ${deniedMessage().replace(/\.$/, '')}. ${hint}`
      );
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('none');
    });

    it('adds the hint for a bare 403 status from a write call', async () => {
      const error = fromCall(
        Object.assign(new Error('Forbidden'), { $metadata: { httpStatusCode: 403 } }),
        'UploadPart'
      );
      mockSaveToS3.mockResolvedValue({ kind: 'error', error });
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        `Failed to save cache to S3: ${error.message.replace(/\.$/, '')}. ${hint}`
      );
    });

    it('does not double the full stop when the S3 message ends with one', async () => {
      mockSaveToS3.mockResolvedValue({
        kind: 'error',
        error: fromCall(
          Object.assign(new Error('Access Denied.'), { name: 'AccessDenied' }),
          'PutObject'
        ),
      });
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        `Failed to save cache to S3: Access Denied. ${hint}`
      );
    });

    it('adds no hint to a 403 with no body from HeadObject, a read call', async () => {
      const error = fromCall(
        Object.assign(new Error('UnknownError'), {
          name: 'Unknown',
          $metadata: { httpStatusCode: 403 },
        }),
        'HeadObject'
      );
      mockSaveToS3.mockResolvedValue({ kind: 'error', error });
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(`Failed to save cache to S3: ${error.message}`);
      expect(error.message).toContain('s3:ListBucket');
      expect(mockWarning).not.toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });

    it('adds no hint to a 403 when the S3 call is not known', async () => {
      mockSaveToS3.mockResolvedValue({
        kind: 'error',
        error: Object.assign(new Error('Access Denied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        }),
      });
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith('Failed to save cache to S3: Access Denied');
    });

    it('adds no hint to a 403 SignatureDoesNotMatch, because the credentials are wrong', async () => {
      mockSaveToS3.mockResolvedValue({
        kind: 'error',
        error: Object.assign(new Error('The request signature we calculated does not match'), {
          name: 'SignatureDoesNotMatch',
          $metadata: { httpStatusCode: 403 },
        }),
      });
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        'Failed to save cache to S3: The request signature we calculated does not match'
      );
      expect(mockSetFailed).not.toHaveBeenCalled();
    });

    it('adds no hint to other errors', async () => {
      mockSaveToS3.mockResolvedValue(failure('SlowDown'));
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith('Failed to save cache to S3: SlowDown');
    });

    it('warns with the hint and saves to GitHub in non-strict dual-cache mode', async () => {
      inputs.set(Inputs.DualCache, 'true');
      mockSaveToS3.mockResolvedValue(denied());
      await saveImpl(state);
      expect(mockWarning).toHaveBeenCalledWith(
        `Dual-cache S3 save error: ${deniedMessage().replace(/\.$/, '')}. ${hint}`
      );
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(outputs.get('cache-saved-sources')).toBe('github');
    });

    it('still fails the step, with the hint, in strict dual-cache mode', async () => {
      inputs.set(Inputs.DualCache, 'true');
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToS3.mockResolvedValue(denied());
      await saveImpl(state);
      expect(mockSetFailed).toHaveBeenCalledWith(
        `Saving to S3 failed: ${deniedMessage().replace(/\.$/, '')}. ${hint}`
      );
    });
  });

  it('runs the wrappers without exiting when earlyExit is false', async () => {
    await expect(runSave(false)).resolves.toBeUndefined();
    await expect(runSaveOnly(false)).resolves.toBeUndefined();
  });

  describe.each([
    ['runSave', runSave],
    ['runSaveOnly', runSaveOnly],
  ])('%s with earlyExit', (_name, run) => {
    let exitCodes: Array<string | number | null | undefined>;
    let exitSpy: { mockRestore(): void };

    beforeEach(() => {
      exitCodes = [];
      exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
        exitCodes.push(code);
      }) as (code?: string | number | null) => never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('exits 1 after a strict dual-cache S3 save error', async () => {
      inputs.set(Inputs.DualCache, 'true');
      inputs.set(Inputs.DualCacheStrict, 'true');
      mockSaveToS3.mockResolvedValue(failure('AccessDenied'));
      await run(true);
      expect(mockSetFailed).toHaveBeenCalledWith('Saving to S3 failed: AccessDenied');
      expect(exitCodes).toEqual([1]);
    });

    it('exits 0 after a successful save', async () => {
      await run(true);
      expect(exitCodes).toEqual([0]);
    });

    it('exits 0 after a save error that is not strict', async () => {
      inputs.set(Inputs.DualCache, 'true');
      mockSaveToS3.mockResolvedValue(failure('AccessDenied'));
      await run(true);
      expect(mockSetFailed).not.toHaveBeenCalled();
      expect(exitCodes).toEqual([0]);
    });
  });

  it('adds the host fields, with the compression and region of the S3 tier, to the metrics', async () => {
    mockHostMetricsFields.mockReturnValue({ platform: 'bitbucket' });

    await saveImpl(state);

    expect(mockHostMetricsFields).toHaveBeenCalledWith('gzip', 'eu-west-1');
    expect(mockEmitMetrics.mock.calls[0][0]).toEqual(
      expect.objectContaining({ step: 'save', platform: 'bitbucket' })
    );
  });
});
