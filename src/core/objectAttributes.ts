import * as core from '@actions/core';

/** User metadata keys starting with this are set by the action and never by the user. */
export const USER_METADATA_RESERVED_PREFIX = 'cloud-cache-';
/** Object metadata key holding the archive's sha256, verified before extracting on restore. */
export const SHA256_METADATA_KEY = 'cloud-cache-sha256';
/** S3's limit on user metadata: the sum of every key and value length, in bytes. */
export const METADATA_LIMIT_BYTES = 2048;
/** Length of a hex sha256 digest, reserved out of the metadata budget. */
const SHA256_ENTRY_BYTES = SHA256_METADATA_KEY.length + 64;

export const MAX_TAGS = 10;
/** With `streaming: true` the reserved checksum tag takes one of S3's ten slots. */
export const MAX_TAGS_WITH_CHECKSUM = MAX_TAGS - 1;
const METADATA_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
const TAG_CHARS = /^[A-Za-z0-9 +\-=._:/@]*$/;

export interface ObjectTag {
  Key: string;
  Value: string;
}

function lines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function splitPair(line: string, inputName: string): [string, string] {
  const at = line.indexOf('=');
  if (at === -1) {
    throw new Error(`Invalid "${inputName}" line "${line}": expected key=value.`);
  }
  return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
}

export function metadataBytes(metadata: Record<string, string>): number {
  return Object.entries(metadata).reduce((sum, [key, value]) => sum + key.length + value.length, 0);
}

/**
 * Parses the `metadata` input: one `key=value` per line, keys lower-cased as S3 does, values
 * printable ASCII. Fails (so the step fails before any S3 call) on a reserved key or when the
 * total, plus the sha256 entry the save adds, would exceed S3's limit.
 */
export function parseMetadata(raw: string, inputName = 'metadata'): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of lines(raw)) {
    const [rawKey, value] = splitPair(line, inputName);
    const key = rawKey.toLowerCase();
    if (!METADATA_KEY_PATTERN.test(key)) {
      throw new Error(
        `Invalid "${inputName}" key "${rawKey}": use letters, digits, ".", "_" or "-", starting with a letter or digit.`
      );
    }
    if (key.startsWith(USER_METADATA_RESERVED_PREFIX)) {
      throw new Error(
        `"${inputName}" key "${key}" is reserved (${USER_METADATA_RESERVED_PREFIX}* keys are set by the action).`
      );
    }
    if (!PRINTABLE_ASCII.test(value)) {
      throw new Error(
        `Invalid "${inputName}" value for "${key}": only printable ASCII is allowed.`
      );
    }
    if (key in metadata) {
      core.warning(`"${inputName}" sets "${key}" more than once; the last value wins.`);
    }
    metadata[key] = value;
  }
  const total = metadataBytes(metadata) + SHA256_ENTRY_BYTES;
  if (total > METADATA_LIMIT_BYTES) {
    throw new Error(
      `${inputName} is too large: ${total} bytes with the ${SHA256_METADATA_KEY} entry; the S3 limit is ${METADATA_LIMIT_BYTES}.`
    );
  }
  return metadata;
}

/** Parses the `tags` input: up to `maxTags` `key=value` lines with S3's tag character set. */
export function parseTags(raw: string, inputName = 'tags', maxTags = MAX_TAGS): ObjectTag[] {
  const tags: ObjectTag[] = [];
  const seen = new Set<string>();
  for (const line of lines(raw)) {
    const [key, value] = splitPair(line, inputName);
    if (key === '' || !TAG_CHARS.test(key)) {
      throw new Error(
        `Invalid "${inputName}" key "${key}": use letters, digits, spaces or + - = . _ : / @.`
      );
    }
    if (key.length > 128) {
      throw new Error(`Invalid "${inputName}" key "${key}": at most 128 characters.`);
    }
    if (!TAG_CHARS.test(value)) {
      throw new Error(
        `Invalid "${inputName}" value for "${key}": use letters, digits, spaces or + - = . _ : / @.`
      );
    }
    if (value.length > 256) {
      throw new Error(`Invalid "${inputName}" value for "${key}": at most 256 characters.`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate "${inputName}" key "${key}".`);
    }
    seen.add(key);
    tags.push({ Key: key, Value: value });
  }
  if (tags.length > maxTags) {
    throw new Error(`"${inputName}" allows at most ${maxTags} tags; got ${tags.length}.`);
  }
  return tags;
}

/** The tag set a streamed save writes: the user's tags plus the action's checksum. */
export function withChecksumTag(tags: readonly ObjectTag[], sha256: string): ObjectTag[] {
  return [...tags, { Key: SHA256_METADATA_KEY, Value: sha256 }];
}

/** The `Tagging` request header value (a URL-encoded query string), or undefined when empty. */
export function encodeTagging(tags: readonly ObjectTag[]): string | undefined {
  if (tags.length === 0) {
    return undefined;
  }
  return tags
    .map((tag) => `${encodeURIComponent(tag.Key)}=${encodeURIComponent(tag.Value)}`)
    .join('&');
}

/** User metadata as reported to workflows: everything except the action's own keys. */
export function stripReservedMetadata(
  metadata: Record<string, string> | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!key.startsWith(USER_METADATA_RESERVED_PREFIX)) {
      result[key] = value;
    }
  }
  return result;
}
