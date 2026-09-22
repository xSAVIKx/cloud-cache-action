import { jest } from '@jest/globals';
import type { S3Client } from '@aws-sdk/client-s3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import type { CompressionConfig } from '../../../src/archive/compression';
import type { CacheConfig } from '../../../src/core/config';
import { compileKeyTemplate } from '../../../src/core/keyTemplate';
import type { StorageContext } from '../../../src/storage/client';
import { makeTempDir, removeDir, setEnv } from '../../support/tempTree';

interface Candidate {
  objectKey: string;
  key?: string;
  version?: string;
  size: number;
  lastModified?: Date;
  accepted: boolean;
}

const mockListCandidates =
  jest.fn<(tier: unknown, ref: string, keyPrefix: string) => Promise<Candidate[]>>();

jest.unstable_mockModule('../../../src/core/s3Tier', () => ({
  listCandidates: mockListCandidates,
}));

const { buildExplainReport, renderExplain, writeExplainSummary } = await import(
  '../../../src/core/explain'
);
type ExplainTier = Parameters<typeof buildExplainReport>[0];

const FEATURE = 'refs/heads/feat';
const MAIN = 'refs/heads/main';
const PATTERN = '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}';
const VERSION = 'v-this-job';
const zstd: CompressionConfig = { method: 'zstd', archiveFilename: 'cache.tar.zst' };

const storage = {
  client: {} as S3Client,
  providerConfig: { provider: 'minio', region: 'us-east-1', forcePathStyle: true },
  bucket: 'cache-bucket',
} as unknown as StorageContext;

const template = compileKeyTemplate({
  pattern: PATTERN,
  repository: 'octo/app',
  prefix: '',
  scopedToRepository: true,
  scopedToRef: true,
  version: VERSION,
  archiveFilename: zstd.archiveFilename,
  env: {},
});

const tier = {
  storage,
  template,
  restoreRefs: [FEATURE, MAIN],
  saveRef: FEATURE,
  compression: zstd,
  workspace: '/w',
  streamRetries: 0,
  metadata: {},
  tags: [],
} as unknown as ExplainTier;

type ExplainConfig = Parameters<typeof buildExplainReport>[1];

const config = (overrides: Partial<CacheConfig> = {}): ExplainConfig =>
  ({
    primaryKey: 'npm-xyz',
    restoreKeys: ['npm-'],
    paths: ['~/.npm'],
    enableCrossOsArchive: false,
    dualCache: false,
    useFallback: false,
    restorePriority: 's3-first',
    ...overrides,
  }) as ExplainConfig;

/** Stubs listCandidates from a `${ref}|${keyPrefix}` map; every other search lists nothing. */
function listing(objects: Record<string, Candidate[]>): void {
  mockListCandidates.mockImplementation(async (_tier, ref, keyPrefix) => [
    ...(objects[`${ref}|${keyPrefix}`] ?? []),
  ]);
}

const candidate = (key: string, version: string, minute: number): Candidate => ({
  objectKey: `octo/app/${encodeURIComponent(FEATURE)}/${key}/${version}/cache.tar.zst`,
  key,
  version,
  size: 1024,
  lastModified: new Date(Date.UTC(2026, 8, 13, 10, minute)),
  accepted: version === VERSION,
});

beforeEach(() => {
  jest.clearAllMocks();
  listing({});
});

describe('buildExplainReport', () => {
  it('reports that nothing matches the prefix on any ref', async () => {
    const report = await buildExplainReport(tier, config());

    expect(report.wouldHit).toBeUndefined();
    expect(report.reasons).toContain(`No objects match key prefix "npm-" on ${FEATURE}, ${MAIN}.`);
    expect(report.provider).toBe('minio');
    expect(report.bucket).toBe('cache-bucket');
    expect(report.version).toBe(VERSION);
    expect(report.refs).toEqual([FEATURE, MAIN]);
    expect(report.tiers).toEqual(['s3']);
  });

  it('reports objects that match the prefix but carry another version', async () => {
    listing({
      [`${FEATURE}|npm-`]: [candidate('npm-a', 'other', 1), candidate('npm-b', 'other', 2)],
    });

    const report = await buildExplainReport(tier, config());

    expect(report.wouldHit).toBeUndefined();
    expect(report.reasons).toContain(
      `2 objects match key prefix "npm-" on ${FEATURE} but none has version ${VERSION} ` +
        `(this job hashes paths ~/.npm with zstd; they were saved with different paths, ` +
        `compression or cross-OS setting).`
    );
    expect(report.searches[1].candidates).toEqual([
      {
        objectKey: candidate('npm-a', 'other', 1).objectKey,
        version: 'other',
        sizeBytes: 1024,
        lastModified: new Date(Date.UTC(2026, 8, 13, 10, 1)).toISOString(),
        versionMatches: false,
      },
      {
        objectKey: candidate('npm-b', 'other', 2).objectKey,
        version: 'other',
        sizeBytes: 1024,
        lastModified: new Date(Date.UTC(2026, 8, 13, 10, 2)).toISOString(),
        versionMatches: false,
      },
    ]);
  });

  it('stops at the first ref that would hit', async () => {
    listing({
      [`${FEATURE}|npm-`]: [candidate('npm-old', VERSION, 1), candidate('npm-abc', VERSION, 5)],
      [`${MAIN}|npm-`]: [candidate('npm-main', VERSION, 9)],
    });

    const report = await buildExplainReport(tier, config());

    expect(report.wouldHit).toEqual({
      objectKey: candidate('npm-abc', VERSION, 5).objectKey,
      matchedKey: 'npm-abc',
      exact: false,
      ref: FEATURE,
    });
    expect(report.searches.map((search) => search.ref)).toEqual([FEATURE, FEATURE]);
    expect(mockListCandidates).not.toHaveBeenCalledWith(expect.anything(), MAIN, expect.anything());
    expect(report.reasons).toContain(
      `Would restore ${candidate('npm-abc', VERSION, 5).objectKey} (key "npm-abc", ${FEATURE}).`
    );
  });

  it('prefers the exact key over a newer sibling under the same prefix', async () => {
    listing({
      [`${FEATURE}|npm-xyz`]: [
        candidate('npm-xyz', VERSION, 1),
        candidate('npm-xyz-2', VERSION, 9),
      ],
    });

    const report = await buildExplainReport(tier, config());

    expect(report.wouldHit).toEqual({
      objectKey: template.objectKey(FEATURE, 'npm-xyz'),
      matchedKey: 'npm-xyz',
      exact: true,
      ref: FEATURE,
    });
  });

  it('explains a restore key that repeats the primary key only once', async () => {
    const report = await buildExplainReport(tier, config({ restoreKeys: ['npm-xyz', 'npm-'] }));

    expect(report.reasons.filter((reason) => reason.includes('"npm-xyz"'))).toEqual([
      `No objects match key prefix "npm-xyz" on ${FEATURE}, ${MAIN}.`,
    ]);
  });

  it('says "1 object matches" for a single candidate', async () => {
    listing({ [`${FEATURE}|npm-`]: [candidate('npm-a', 'other', 1)] });

    const report = await buildExplainReport(tier, config());

    expect(report.reasons).toContain(
      `1 object matches key prefix "npm-" on ${FEATURE} but none has version ${VERSION} ` +
        `(this job hashes paths ~/.npm with zstd; they were saved with different paths, ` +
        `compression or cross-OS setting).`
    );
  });

  it('truncates the candidate list and says how many were cut', async () => {
    listing({
      [`${FEATURE}|npm-`]: [candidate('npm-a', 'other', 1), candidate('npm-b', 'other', 2)],
    });

    const report = await buildExplainReport(tier, config(), { maxCandidates: 1 });

    expect(report.searches[1].candidates).toHaveLength(1);
    expect(report.searches[1].truncated).toBe(1);
    expect(report.searches[0].truncated).toBe(0);
  });

  it('lists every ref and key at once and still reports them in precedence order', async () => {
    let inFlight = 0;
    let peak = 0;
    const previousMockListCandidates = mockListCandidates.getMockImplementation();
    mockListCandidates.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [];
    });

    const report = await buildExplainReport(tier, config());

    if (previousMockListCandidates) {
      mockListCandidates.mockImplementation(previousMockListCandidates);
    }

    expect(peak).toBeGreaterThan(1);
    expect(report.searches.map((search) => [search.ref, search.key])).toEqual([
      [FEATURE, 'npm-xyz'],
      [FEATURE, 'npm-'],
      [MAIN, 'npm-xyz'],
      [MAIN, 'npm-'],
    ]);
  });
});

describe('renderExplain', () => {
  it('renders the pattern, version, refs, tiers and one line per search', async () => {
    listing({
      [`${FEATURE}|npm-`]: [candidate('npm-a', 'other', 1)],
    });

    const report = await buildExplainReport(
      tier,
      config({ dualCache: true, restorePriority: 's3-first' })
    );
    const lines = renderExplain(report);

    expect(lines[0]).toBe('Cache lookup for key "npm-xyz"');
    expect(lines[1]).toBe('Bucket: s3://cache-bucket (minio)');
    expect(lines).toContain(
      `Pattern: ${PATTERN} → octo/app/\${ref}/\${key}/\${version}/\${archive_filename}`
    );
    expect(lines).toContain(
      `Version: ${VERSION} (paths: ~/.npm; compression: zstd; cross-OS: false)`
    );
    expect(lines).toContain(`Refs searched: ${FEATURE} → ${MAIN}`);
    expect(lines).toContain('Tiers: s3 → github');
    expect(lines).toContain(`[${FEATURE}] prefix "octo/app/refs%2Fheads%2Ffeat/npm-": 1 candidate`);
    expect(lines.some((line) => line.includes('✗') && line.includes('version other'))).toBe(true);
    expect(lines).toContain('Restore keys: npm-');
    expect(lines.some((line) => line.startsWith('Result: '))).toBe(true);
  });

  it('renders the GitHub tier first when dual-cache prefers it', async () => {
    const report = await buildExplainReport(
      tier,
      config({ dualCache: true, restorePriority: 'github-first' })
    );

    expect(report.tiers).toEqual(['github', 's3']);
    expect(renderExplain(report)).toContain('Tiers: github → s3');
  });

  it('renders the cut candidates as one "and N more" line', async () => {
    listing({
      [`${FEATURE}|npm-`]: [candidate('npm-a', 'other', 1), candidate('npm-b', 'other', 2)],
    });

    const report = await buildExplainReport(tier, config(), { maxCandidates: 1 });
    const lines = renderExplain(report);

    expect(lines).toContain('  … and 1 more not shown');
    expect(lines.filter((line) => line.includes('✗'))).toHaveLength(1);
  });

  it('renders an unscoped lookup without refs', async () => {
    const unscopedTemplate = compileKeyTemplate({
      pattern: PATTERN,
      repository: 'octo/app',
      prefix: '',
      scopedToRepository: true,
      scopedToRef: false,
      version: VERSION,
      archiveFilename: zstd.archiveFilename,
      env: {},
    });
    const unscoped = {
      ...(tier as object),
      template: unscopedTemplate,
      restoreRefs: [''],
    } as unknown as ExplainTier;

    const report = await buildExplainReport(unscoped, config({ restoreKeys: [] }));
    const lines = renderExplain(report);

    expect(report.refs).toEqual([]);
    expect(report.searches[0].ref).toBeNull();
    expect(lines).toContain('Not scoped to a ref');
    expect(lines).toContain('[unscoped] prefix "octo/app/npm-xyz": 0 candidates');
    expect(lines.some((line) => line.startsWith('Restore keys:'))).toBe(false);
    expect(report.reasons).toEqual([
      'No objects match key prefix "npm-xyz" on the unscoped prefix.',
    ]);
  });
});

describe('writeExplainSummary', () => {
  let dir: string;
  let summaryFile: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    dir = makeTempDir('explain-summary');
    summaryFile = path.join(dir, 'step-summary.md');
    fs.writeFileSync(summaryFile, '');
    restoreEnv = setEnv({ GITHUB_STEP_SUMMARY: summaryFile });
    // core.summary caches the resolved file path on first use; reset it for this temp file.
    (core.summary as unknown as { _filePath?: string })._filePath = undefined;
  });

  afterEach(() => {
    core.summary.emptyBuffer();
    restoreEnv();
    removeDir(dir);
  });

  it('writes the rendered report and escapes it', async () => {
    const report = await buildExplainReport(tier, config({ primaryKey: 'npm-<x>' }));

    await writeExplainSummary(report, true);

    const written = fs.readFileSync(summaryFile, 'utf8');
    expect(written).toContain('Cache lookup explained');
    expect(written).toContain('npm-&lt;x&gt;');
    expect(written).toContain('<pre>');
  });

  it('writes nothing when the job summary is off', async () => {
    const report = await buildExplainReport(tier, config());

    await writeExplainSummary(report, false);

    expect(fs.readFileSync(summaryFile, 'utf8')).toBe('');
  });
});
