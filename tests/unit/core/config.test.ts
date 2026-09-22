import { jest } from '@jest/globals';
import { Defaults, Inputs, State } from '../../../src/constants';
import { MemoryState } from '../../support/memoryState';

const inputs = new Map<string, string>();
const mockWarning = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  warning: mockWarning,
}));

const { persistCacheConfig, readCacheConfig } = await import('../../../src/core/config');

describe('readCacheConfig', () => {
  beforeEach(() => {
    inputs.clear();
    mockWarning.mockReset();
    inputs.set(Inputs.Key, 'Linux-npm-abc');
    inputs.set(Inputs.Path, '~/.npm\nnode_modules');
  });

  it('applies the action defaults when optional inputs are empty', () => {
    expect(readCacheConfig()).toEqual({
      primaryKey: 'Linux-npm-abc',
      paths: ['~/.npm', 'node_modules'],
      restoreKeys: [],
      lookupOnly: false,
      failOnCacheMiss: false,
      readOnly: false,
      enableCrossOsArchive: false,
      uploadChunkSize: undefined,
      uploadConcurrency: 8,
      s3KeyPattern: Defaults.DefaultS3KeyPattern,
      prefix: '',
      scopedToRepository: true,
      scopedToRef: true,
      retryEnabled: true,
      retryCount: 3,
      useFallback: false,
      dualCache: false,
      restorePriority: 's3-first',
      dualCacheStrategy: 'backfill',
      dualCacheStrict: false,
      streaming: false,
      downloadConcurrency: 8,
      downloadChunkSize: 8388608,
      jobSummary: true,
      metadata: {},
      tags: [],
      explain: false,
      metricsFile: '',
    });
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('reads the explain input', () => {
    inputs.set(Inputs.Explain, 'true');
    expect(readCacheConfig().explain).toBe(true);
  });

  it('reads the streaming input', () => {
    inputs.set(Inputs.Streaming, 'true');
    expect(readCacheConfig().streaming).toBe(true);
  });

  it('reads download-concurrency and download-chunk-size', () => {
    inputs.set(Inputs.DownloadConcurrency, '4');
    inputs.set(Inputs.DownloadChunkSize, '16777216');
    expect(readCacheConfig()).toMatchObject({
      downloadConcurrency: 4,
      downloadChunkSize: 16777216,
    });
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it.each([
    [Inputs.DownloadConcurrency, '0', 'downloadConcurrency', 8, '1 and 32'],
    [Inputs.DownloadConcurrency, '33', 'downloadConcurrency', 8, '1 and 32'],
    [Inputs.DownloadConcurrency, 'eight', 'downloadConcurrency', 8, '1 and 32'],
    [Inputs.DownloadChunkSize, '1048575', 'downloadChunkSize', 8388608, '1048576 and 134217728'],
    [Inputs.DownloadChunkSize, '-5', 'downloadChunkSize', 8388608, '1048576 and 134217728'],
    [Inputs.UploadConcurrency, '0', 'uploadConcurrency', 8, '1 and 32'],
    [Inputs.UploadConcurrency, '40', 'uploadConcurrency', 8, '1 and 32'],
  ])('warns and uses the default when %s is %s', (name, raw, field, expected, bounds) => {
    inputs.set(name, raw);
    expect(readCacheConfig()).toMatchObject({ [field]: expected });
    expect(mockWarning).toHaveBeenCalledWith(
      `Input "${name}" must be an integer between ${bounds}; got "${raw}". Using ${expected}.`
    );
  });

  it('reads upload-chunk-size and upload-concurrency', () => {
    inputs.set(Inputs.UploadChunkSize, '33554432');
    inputs.set(Inputs.UploadConcurrency, '16');
    expect(readCacheConfig()).toMatchObject({ uploadChunkSize: 33554432, uploadConcurrency: 16 });
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it.each(['5242879', '134217729', '10mb'])(
    'warns and leaves upload-chunk-size unset when it is %s',
    (raw) => {
      inputs.set(Inputs.UploadChunkSize, raw);
      expect(readCacheConfig().uploadChunkSize).toBeUndefined();
      expect(mockWarning).toHaveBeenCalledWith(
        `Input "upload-chunk-size" must be an integer between 5242880 and 134217728; got "${raw}". Using 67108864.`
      );
    }
  );

  it('accepts the download bounds themselves', () => {
    inputs.set(Inputs.DownloadConcurrency, '1');
    inputs.set(Inputs.DownloadChunkSize, '134217728');
    expect(readCacheConfig()).toMatchObject({
      downloadConcurrency: 1,
      downloadChunkSize: 134217728,
    });
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('honours retry-count: 0', () => {
    inputs.set(Inputs.RetryCount, '0');
    expect(readCacheConfig().retryCount).toBe(0);
  });

  it('warns and uses the default for an unknown restore-priority', () => {
    inputs.set(Inputs.RestorePriority, 'S3-FIRST');
    expect(readCacheConfig().restorePriority).toBe('s3-first');
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('restore-priority'));
  });

  it('maps the removed independent strategy to backfill with a single warning', () => {
    inputs.set(Inputs.DualCacheStrategy, 'independent');
    expect(readCacheConfig().dualCacheStrategy).toBe('backfill');
    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('"independent" was removed'));
  });

  it('warns and uses the default for an invalid boolean', () => {
    inputs.set(Inputs.ScopedToRef, 'yes');
    expect(readCacheConfig().scopedToRef).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('scoped-to-ref'));
  });

  it('prefers what the restore step persisted over post-step inputs', () => {
    const state = new MemoryState();
    persistCacheConfig(state, {
      ...readCacheConfig(),
      primaryKey: 'restored-key',
      retryCount: 0,
      scopedToRef: false,
      dualCacheStrategy: 'skip-on-hit',
      restorePriority: 'github-first',
      readOnly: true,
      streaming: true,
    });
    inputs.set(Inputs.Key, 'post-step-key');
    inputs.set(Inputs.DualCacheStrategy, 'independent');
    inputs.set(Inputs.RestorePriority, 'bogus');
    inputs.set(Inputs.Streaming, 'false');

    expect(readCacheConfig(state)).toMatchObject({
      primaryKey: 'restored-key',
      retryCount: 0,
      scopedToRef: false,
      dualCacheStrategy: 'skip-on-hit',
      restorePriority: 'github-first',
      readOnly: true,
      streaming: true,
    });
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('does not persist explain: the post step never explains', () => {
    inputs.set(Inputs.Explain, 'true');
    const state = new MemoryState();
    persistCacheConfig(state, readCacheConfig());
    inputs.delete(Inputs.Explain);
    expect(readCacheConfig(state).explain).toBe(false);
  });
});

describe('metadata and tags inputs', () => {
  beforeEach(() => {
    inputs.clear();
    mockWarning.mockReset();
    inputs.set(Inputs.Key, 'Linux-npm-abc');
    inputs.set(Inputs.Path, '~/.npm\nnode_modules');
  });

  it('default to empty', () => {
    const config = readCacheConfig();
    expect(config.metadata).toEqual({});
    expect(config.tags).toEqual([]);
  });

  it('are parsed from the inputs and persisted as JSON for the post step', () => {
    inputs.set(Inputs.Metadata, 'team=platform\nbuild=42');
    inputs.set(Inputs.Tags, 'repo=acme/app');
    const state = new MemoryState();
    const config = readCacheConfig();
    persistCacheConfig(state, config);
    expect(state.getState(State.CacheMetadata)).toBe('{"team":"platform","build":"42"}');
    expect(state.getState(State.CacheTags)).toBe('[{"Key":"repo","Value":"acme/app"}]');

    inputs.delete(Inputs.Metadata);
    inputs.delete(Inputs.Tags);
    const post = readCacheConfig(state);
    expect(post.metadata).toEqual({ team: 'platform', build: '42' });
    expect(post.tags).toEqual([{ Key: 'repo', Value: 'acme/app' }]);
  });

  it('fails on an invalid value', () => {
    inputs.set(Inputs.Metadata, 'cloud-cache-x=1');
    expect(() => readCacheConfig()).toThrow('reserved');
  });

  it('caps tags at nine when streaming, because the checksum takes a slot', () => {
    inputs.set(Inputs.Streaming, 'true');
    inputs.set(Inputs.Tags, Array.from({ length: 10 }, (_, i) => `k${i}=v`).join('\n'));
    expect(() => readCacheConfig()).toThrow('"tags" allows at most 9 tags; got 10.');
  });

  it('still allows ten tags without streaming', () => {
    inputs.set(Inputs.Tags, Array.from({ length: 10 }, (_, i) => `k${i}=v`).join('\n'));
    expect(readCacheConfig().tags).toHaveLength(10);
  });
});
