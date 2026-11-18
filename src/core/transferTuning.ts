/**
 * The `transfer-tuning: auto` rules: the part size and the concurrency for one transfer, from the
 * object size and the provider. Pure on purpose, so any CI front end can use it. The values come
 * from the size sweep in benchmark run 39905131759 (128, 512 and 2048 MiB on AWS S3, Cloudflare
 * R2 and Google Cloud Storage, on a 4-CPU runner); the benchmark page lists the measurements.
 */

import type { StorageProvider } from '../storage/providers';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** S3 accepts at most this many parts in one multipart upload. */
export const MAX_UPLOAD_PARTS = 10_000;
/** S3 accepts at most this many bytes in one upload part. */
export const MAX_S3_PART_SIZE = 5 * GiB;
/** At most this many bytes in flight, whatever the free memory. */
const MAX_BUFFERED_BYTES = 1 * GiB;

export interface TransferSettings {
  concurrency: number;
  partSize: number;
}

export interface TuningInput {
  direction: 'upload' | 'download';
  sizeBytes: number;
  /** The resolved provider. Only the upload rule uses it. */
  provider: StorageProvider;
  /** The memory the process can use when the transfer starts. A quarter of it is the budget. */
  freeMemoryBytes: number;
  /**
   * The values the workflow set. They replace the rule's values and are never reduced. A set upload
   * part size goes up when the upload would need more than 10,000 parts.
   */
  fixed?: Partial<TransferSettings>;
}

/**
 * Downloads: 16 MiB parts, 16 at a time. Every provider reached its top group with 128 MiB or
 * more in flight; the 8 x 8 MiB default was the slowest or close to it at every size.
 */
function downloadRule(sizeBytes: number): TransferSettings {
  const partSize = 16 * MiB;
  const parts = Math.max(1, Math.ceil(sizeBytes / partSize));
  return { concurrency: Math.min(16, parts), partSize };
}

/**
 * The smallest part size, in whole MiB, that uploads `sizeBytes` in at most 10,000 parts. The
 * result can be above the 5 GiB part limit of S3; the caller checks that.
 */
export function minUploadPartSize(sizeBytes: number): number {
  return Math.ceil(sizeBytes / MAX_UPLOAD_PARTS / MiB) * MiB;
}

/**
 * Uploads: 16 at a time, with 16 MiB parts up to 256 MiB and 32 MiB parts above, so a small
 * archive still gets several parts. R2 gained most from more parts in flight on a large archive,
 * so R2 uploads of 1 GiB or more use 32 x 16 MiB. The part size grows when the archive would
 * need more than 10,000 parts.
 */
function uploadRule(sizeBytes: number, provider: StorageProvider): TransferSettings {
  let settings: TransferSettings =
    provider === 'r2' && sizeBytes >= GiB
      ? { concurrency: 32, partSize: 16 * MiB }
      : { concurrency: 16, partSize: sizeBytes <= 256 * MiB ? 16 * MiB : 32 * MiB };
  const minPartSize = minUploadPartSize(sizeBytes);
  if (minPartSize > settings.partSize) {
    settings = { ...settings, partSize: minPartSize };
  }
  return settings;
}

/**
 * Returns the settings for one transfer: the rule's values, with the `fixed` values in their
 * place. The budget is a quarter of the free memory, at most 1 GiB. The code that reads the parts
 * holds one part more than the concurrency, so a tuned concurrency goes down until
 * `(concurrency + 1) * partSize` fits the budget, to 1 at the lowest. The part size does not
 * shrink, so a very small budget still gets one part in flight. A concurrency that the workflow
 * set is not reduced.
 */
export function tuneTransfer(input: TuningInput): TransferSettings {
  const rule =
    input.direction === 'download'
      ? downloadRule(input.sizeBytes)
      : uploadRule(input.sizeBytes, input.provider);
  const partSize =
    input.direction === 'upload'
      ? Math.max(input.fixed?.partSize ?? rule.partSize, minUploadPartSize(input.sizeBytes))
      : (input.fixed?.partSize ?? rule.partSize);
  if (input.fixed?.concurrency !== undefined) {
    return { concurrency: input.fixed.concurrency, partSize };
  }
  const budget = Math.min(MAX_BUFFERED_BYTES, Math.floor(input.freeMemoryBytes / 4));
  const fits = Math.max(1, Math.floor(budget / partSize) - 1);
  return { concurrency: Math.min(rule.concurrency, fits), partSize };
}

/**
 * `Transfer tuning: auto selected 16 x 16 MiB for the download of 2.0 GiB`. A value that the
 * workflow set is marked `(set)`.
 */
export function formatTuning(
  direction: 'upload' | 'download',
  settings: TransferSettings,
  sizeBytes: number,
  fixed: Partial<TransferSettings> = {}
): string {
  const size =
    sizeBytes >= GiB
      ? `${(sizeBytes / GiB).toFixed(1)} GiB`
      : `${(sizeBytes / MiB).toFixed(0)} MiB`;
  const concurrency = `${settings.concurrency}${fixed.concurrency === undefined ? '' : ' (set)'}`;
  const partSize = `${settings.partSize / MiB} MiB${fixed.partSize === undefined ? '' : ' (set)'}`;
  return `Transfer tuning: auto selected ${concurrency} x ${partSize} for the ${direction} of ${size}`;
}
