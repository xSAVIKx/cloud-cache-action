/** An S3 object that failed the sha256 integrity check: its key and the ETag it had. */
export interface RejectedObject {
  objectKey: string;
  etag: string;
}

export interface S3ObjectInfo {
  objectKey: string;
  size: number;
  etag?: string;
  metadata?: Record<string, string>;
}

/**
 * What one cache tier did during restore. Tiers report failures; orchestrators decide.
 * `transferMs` is the S3 download alone, so a step's metrics can separate it from archiving.
 */
export type RestoreOutcome =
  | {
      kind: 'hit';
      matchedKey: string;
      exact: boolean;
      s3?: S3ObjectInfo;
      transferMs?: number;
      /** Ranged requests the S3 download used; 1 for a single GetObject. */
      downloadParts?: number;
      /** The S3 lookup for the matching object. */
      lookupMs?: number;
      /** The unpack of a downloaded archive file; unset in streaming mode. */
      extractMs?: number;
    }
  | { kind: 'miss' }
  | {
      kind: 'error';
      error: Error;
      /**
       * Set when the object of the exact primary key failed the sha256 integrity check. A later
       * save of the primary key replaces this object while it still has this ETag (see saveToS3).
       */
      rejected?: RejectedObject;
    };

/** What one cache tier did during save. `transferMs` is the S3 upload alone. */
export type SaveOutcome =
  | {
      kind: 'saved';
      s3?: S3ObjectInfo;
      transferMs?: number;
      archiveMs?: number;
      /** True when the upload replaced an object that failed the integrity check. */
      replaced?: boolean;
    }
  | { kind: 'exists'; s3?: S3ObjectInfo; transferMs?: number; archiveMs?: number }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; error: Error };

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
