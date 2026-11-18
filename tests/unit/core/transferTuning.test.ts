import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatTuning,
  minUploadPartSize,
  tuneTransfer,
  type TuningInput,
} from '../../../src/core/transferTuning';
import type { StorageProvider } from '../../../src/storage/providers';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const input = (overrides: Partial<TuningInput> = {}): TuningInput => ({
  direction: 'download',
  sizeBytes: 2 * GiB,
  provider: 'aws',
  freeMemoryBytes: 12 * GiB,
  ...overrides,
});

describe('tuneTransfer', () => {
  it('downloads in 16 MiB parts, 16 at a time, on every provider', () => {
    for (const provider of ['aws', 'r2', 'gcs', 'generic-s3'] as StorageProvider[]) {
      expect(tuneTransfer(input({ provider }))).toEqual({ concurrency: 16, partSize: 16 * MiB });
    }
  });

  it('runs no more downloads at once than the object has parts', () => {
    expect(tuneTransfer(input({ sizeBytes: 40 * MiB }))).toEqual({
      concurrency: 3,
      partSize: 16 * MiB,
    });
    expect(tuneTransfer(input({ sizeBytes: 0 }))).toEqual({ concurrency: 1, partSize: 16 * MiB });
  });

  it('counts the download parts from a part size that the workflow set', () => {
    expect(tuneTransfer(input({ sizeBytes: 20 * MiB, fixed: { partSize: MiB } }))).toEqual({
      concurrency: 16,
      partSize: MiB,
    });
    expect(tuneTransfer(input({ sizeBytes: 100 * MiB, fixed: { partSize: 4 * MiB } }))).toEqual({
      concurrency: 16,
      partSize: 4 * MiB,
    });
    expect(tuneTransfer(input({ sizeBytes: 20 * MiB, fixed: { partSize: 8 * MiB } }))).toEqual({
      concurrency: 3,
      partSize: 8 * MiB,
    });
  });

  it('uploads up to 256 MiB in 16 MiB parts, 16 at a time', () => {
    expect(tuneTransfer(input({ direction: 'upload', sizeBytes: 128 * MiB }))).toEqual({
      concurrency: 16,
      partSize: 16 * MiB,
    });
    expect(tuneTransfer(input({ direction: 'upload', sizeBytes: 256 * MiB }))).toEqual({
      concurrency: 16,
      partSize: 16 * MiB,
    });
  });

  it('uploads more than 256 MiB in 32 MiB parts, 16 at a time', () => {
    for (const sizeBytes of [512 * MiB, 2 * GiB]) {
      expect(tuneTransfer(input({ direction: 'upload', sizeBytes }))).toEqual({
        concurrency: 16,
        partSize: 32 * MiB,
      });
    }
  });

  it('uploads 1 GiB or more to R2 in 16 MiB parts, 32 at a time', () => {
    expect(tuneTransfer(input({ direction: 'upload', provider: 'r2', sizeBytes: GiB }))).toEqual({
      concurrency: 32,
      partSize: 16 * MiB,
    });
    expect(
      tuneTransfer(input({ direction: 'upload', provider: 'r2', sizeBytes: 512 * MiB }))
    ).toEqual({ concurrency: 16, partSize: 32 * MiB });
  });

  it('grows the upload part size so that no upload needs more than 10,000 parts', () => {
    const settings = tuneTransfer(input({ direction: 'upload', sizeBytes: 500 * GiB }));
    expect(settings.partSize).toBe(52 * MiB);
    expect(Math.ceil((500 * GiB) / settings.partSize)).toBeLessThanOrEqual(10_000);
    const r2 = tuneTransfer(input({ direction: 'upload', provider: 'r2', sizeBytes: 500 * GiB }));
    expect(r2.partSize).toBe(52 * MiB);
  });

  it('grows the upload part size above the 128 MiB input limit for the 10,000-part limit', () => {
    const sizeBytes = 2048 * GiB;
    const settings = tuneTransfer(input({ direction: 'upload', sizeBytes }));
    expect(settings.partSize).toBe(210 * MiB);
    expect(Math.ceil(sizeBytes / settings.partSize)).toBeLessThanOrEqual(10_000);
  });

  it('grows a part size that the workflow set when the upload needs more than 10,000 parts', () => {
    const sizeBytes = 60 * GiB;
    const settings = tuneTransfer(
      input({ direction: 'upload', sizeBytes, fixed: { partSize: 5 * MiB } })
    );
    expect(settings.partSize).toBe(7 * MiB);
    expect(Math.ceil(sizeBytes / settings.partSize)).toBeLessThanOrEqual(10_000);
    // The memory budget uses the grown part size.
    expect(
      tuneTransfer(
        input({
          direction: 'upload',
          sizeBytes,
          freeMemoryBytes: 64 * MiB,
          fixed: { partSize: 5 * MiB },
        })
      )
    ).toEqual({ concurrency: 1, partSize: 7 * MiB });
  });

  it('keeps a set upload part size that is large enough', () => {
    expect(
      tuneTransfer(
        input({ direction: 'upload', sizeBytes: 40 * GiB, fixed: { partSize: 5 * MiB } })
      ).partSize
    ).toBe(5 * MiB);
  });

  it('does not grow a download part size', () => {
    expect(tuneTransfer(input({ sizeBytes: 60 * GiB, fixed: { partSize: MiB } })).partSize).toBe(
      MiB
    );
  });

  it('keeps concurrency + 1 parts within a quarter of the free memory', () => {
    // 128 MiB budget / 16 MiB parts = 8 parts, one of them read ahead.
    expect(tuneTransfer(input({ freeMemoryBytes: 512 * MiB }))).toEqual({
      concurrency: 7,
      partSize: 16 * MiB,
    });
    expect(tuneTransfer(input({ direction: 'upload', freeMemoryBytes: GiB }))).toEqual({
      concurrency: 7,
      partSize: 32 * MiB,
    });
  });

  it('keeps the bytes in flight within 1 GiB, whatever the free memory', () => {
    const settings = tuneTransfer(
      input({ direction: 'upload', sizeBytes: 5000 * GiB, freeMemoryBytes: 256 * GiB })
    );
    // 512 MiB parts for 10,000 parts; two of them fill the 1 GiB.
    expect(settings).toEqual({ concurrency: 1, partSize: 512 * MiB });
  });

  it('bounds the tuned concurrency by a part size that the workflow set', () => {
    for (const direction of ['download', 'upload'] as const) {
      expect(tuneTransfer(input({ direction, fixed: { partSize: 128 * MiB } }))).toEqual({
        concurrency: 7,
        partSize: 128 * MiB,
      });
    }
  });

  it('keeps a concurrency that the workflow set, and tunes the part size', () => {
    expect(tuneTransfer(input({ freeMemoryBytes: 64 * MiB, fixed: { concurrency: 24 } }))).toEqual({
      concurrency: 24,
      partSize: 16 * MiB,
    });
  });

  it('never goes below one transfer at a time', () => {
    expect(tuneTransfer(input({ freeMemoryBytes: 0 })).concurrency).toBe(1);
  });
});

describe('minUploadPartSize', () => {
  it('rounds the smallest part size for 10,000 parts up to whole MiB', () => {
    expect(minUploadPartSize(0)).toBe(0);
    expect(minUploadPartSize(10_000 * MiB)).toBe(MiB);
    expect(minUploadPartSize(10_000 * MiB + 1)).toBe(2 * MiB);
    expect(minUploadPartSize(60 * GiB)).toBe(7 * MiB);
  });
});

describe('formatTuning', () => {
  it('names the settings, the direction and the size', () => {
    expect(formatTuning('download', { concurrency: 16, partSize: 16 * MiB }, 2 * GiB)).toBe(
      'Transfer tuning: auto selected 16 x 16 MiB for the download of 2.0 GiB'
    );
    expect(formatTuning('upload', { concurrency: 16, partSize: 16 * MiB }, 128 * MiB)).toBe(
      'Transfer tuning: auto selected 16 x 16 MiB for the upload of 128 MiB'
    );
  });

  it('marks the values that the workflow set', () => {
    expect(
      formatTuning('download', { concurrency: 5, partSize: 16 * MiB }, 2 * GiB, { concurrency: 5 })
    ).toBe('Transfer tuning: auto selected 5 (set) x 16 MiB for the download of 2.0 GiB');
    expect(
      formatTuning('upload', { concurrency: 7, partSize: 128 * MiB }, 2 * GiB, {
        partSize: 128 * MiB,
      })
    ).toBe('Transfer tuning: auto selected 7 x 128 MiB (set) for the upload of 2.0 GiB');
  });

  it('stays free of runtime imports, so any CI front end can use it', () => {
    const source = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../src/core/transferTuning.ts'
      ),
      'utf8'
    );
    const imports = source.split('\n').filter((line) => /^import\s/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((line) => line.startsWith('import type '))).toBe(true);
  });
});
