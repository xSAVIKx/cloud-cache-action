export enum Inputs {
  Key = 'key',
  Path = 'path',
  RestoreKeys = 'restore-keys',
  UploadChunkSize = 'upload-chunk-size',
  UploadConcurrency = 'upload-concurrency',
  CompressionLevel = 'compression-level',
  EnableCrossOsArchive = 'enableCrossOsArchive',
  FailOnCacheMiss = 'fail-on-cache-miss',
  LookupOnly = 'lookup-only',
  ReadOnly = 'read-only',

  Bucket = 'bucket',
  Endpoint = 'endpoint',
  Region = 'region',
  Provider = 'provider',
  AccessKey = 'access-key',
  AccessKeyCamel = 'accessKey',
  SecretKey = 'secret-key',
  SecretKeyCamel = 'secretKey',
  SessionToken = 'session-token',
  SessionTokenCamel = 'sessionToken',
  ForcePathStyle = 'force-path-style',
  Prefix = 'prefix',
  S3KeyPattern = 's3-key-pattern',
  ScopedToRepository = 'scoped-to-repository',
  ScopedToRef = 'scoped-to-ref',
  Retry = 'retry',
  RetryCount = 'retry-count',
  UseFallback = 'use-fallback',
  Streaming = 'streaming',
  DownloadConcurrency = 'download-concurrency',
  DownloadChunkSize = 'download-chunk-size',
  Metadata = 'metadata',
  Tags = 'tags',

  // Prune-only inputs
  OlderThanDays = 'older-than-days',
  Ref = 'ref',
  DryRun = 'dry-run',

  // Dual-cache inputs
  DualCache = 'dual-cache',
  RestorePriority = 'restore-priority',
  DualCacheStrategy = 'dual-cache-strategy',
  DualCacheStrict = 'dual-cache-strict',

  // Job summary input
  JobSummary = 'job-summary',

  // Explain input
  Explain = 'explain',

  // Inspect-only input
  MaxCandidates = 'max-candidates',

  // Metrics input
  MetricsFile = 'metrics-file',
}

export enum Outputs {
  CacheHit = 'cache-hit',
  CachePrimaryKey = 'cache-primary-key',
  CacheMatchedKey = 'cache-matched-key',
  CacheSize = 'cache-size',
  CacheStorageProvider = 'cache-storage-provider',
  CacheS3Key = 'cache-s3-key',
  CacheETag = 'cache-etag',
  CacheMetadata = 'cache-metadata',

  // Dual-cache outputs
  CacheHitSource = 'cache-hit-source',
  CacheSavedSources = 'cache-saved-sources',

  // Metrics outputs
  CacheRestoreDurationMs = 'cache-restore-duration-ms',
  CacheSaveDurationMs = 'cache-save-duration-ms',
  CacheTransferDurationMs = 'cache-transfer-duration-ms',
  CacheBytes = 'cache-bytes',

  // Prune-only outputs
  PrunedCount = 'pruned-count',
  PrunedBytes = 'pruned-bytes',
  KeptCount = 'kept-count',

  // Inspect-only outputs
  WouldHit = 'would-hit',
  WouldMatchKey = 'would-match-key',
  WouldMatchObject = 'would-match-object',
  CandidateCount = 'candidate-count',
  Report = 'report',
}

export enum State {
  CachePrimaryKey = 'CACHE_PRIMARY_KEY',
  CacheMatchedKey = 'CACHE_MATCHED_KEY',
  CacheStorageProvider = 'CACHE_STORAGE_PROVIDER',
  CacheS3Key = 'CACHE_S3_KEY',
  CachePrefix = 'CACHE_PREFIX',
  CacheS3KeyPattern = 'CACHE_S3_KEY_PATTERN',
  CacheScopedToRepository = 'CACHE_SCOPED_TO_REPOSITORY',
  CacheScopedToRef = 'CACHE_SCOPED_TO_REF',
  CacheRetry = 'CACHE_RETRY',
  CacheRetryCount = 'CACHE_RETRY_COUNT',
  CacheReadOnly = 'CACHE_READ_ONLY',
  CacheCompression = 'CACHE_COMPRESSION',
  CacheStreaming = 'CACHE_STREAMING',
  CacheMetadata = 'CACHE_METADATA',
  CacheTags = 'CACHE_TAGS',

  // Dual-cache state
  CacheDualCache = 'CACHE_DUAL_CACHE',
  CacheRestorePriority = 'CACHE_RESTORE_PRIORITY',
  CacheDualCacheStrategy = 'CACHE_DUAL_CACHE_STRATEGY',
  CacheDualCacheStrict = 'CACHE_DUAL_CACHE_STRICT',
  CacheS3ExactHit = 'CACHE_S3_EXACT_HIT',
  CacheGithubExactHit = 'CACHE_GITHUB_EXACT_HIT',
  CacheHitSource = 'CACHE_HIT_SOURCE',
  CacheJobSummary = 'CACHE_JOB_SUMMARY',
  CacheMetricsFile = 'CACHE_METRICS_FILE',
}

export enum Events {
  Key = 'GITHUB_EVENT_NAME',
}

export const Defaults = {
  DefaultRegion: 'us-east-1',
  DefaultS3KeyPattern: '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}',
  DefaultArchiveFilenameZstd: 'cache.tar.zst',
  DefaultArchiveFilenameGzip: 'cache.tar.gz',
  DefaultRetryCount: 3,
  // Transfer defaults follow actions/cache (8 concurrent downloads, 8 concurrent 64 MiB upload
  // parts, fan-out capped at 32 and part size at 128 MiB), except the download block: actions/cache
  // uses 4 MiB, but 8 MiB measured 1.2x to 2.6x faster on R2, S3 and GCS (docs/guide/performance.md).
  DefaultDownloadConcurrency: 8,
  MaxDownloadConcurrency: 32,
  DefaultDownloadChunkSize: 8 * 1024 * 1024,
  MinDownloadChunkSize: 1024 * 1024,
  MaxDownloadChunkSize: 128 * 1024 * 1024,
  DefaultUploadConcurrency: 8,
  MaxUploadConcurrency: 32,
  DefaultUploadChunkSize: 64 * 1024 * 1024,
  /** S3, R2, B2 and GCS all reject multipart parts smaller than 5 MiB (except the last). */
  MinUploadChunkSize: 5 * 1024 * 1024,
  MaxUploadChunkSize: 128 * 1024 * 1024,
  DefaultRestorePriority: 's3-first',
  DefaultDualCacheStrategy: 'backfill',
  /** zstd accepts 1 to 22, but past 19 it needs --ultra, so the input stops there. */
  MaxCompressionLevel: 19,
  MaxGzipCompressionLevel: 9,
  /** Mixed into every cache version; bump it when the archive format changes incompatibly. */
  VersionSalt: 'cloud-cache-1',
};
