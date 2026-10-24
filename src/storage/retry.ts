import { log } from '../ci/log';

export interface RetryOptions {
  retries: number;
  minTimeoutMs?: number;
  factor?: number;
  maxJitterMs?: number;
  operationName?: string;
  shouldRetry?: (err: unknown) => boolean;
}

const RETRYABLE_ERROR_NAMES = new Set([
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
]);

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/** True for failures worth another attempt: 5xx, 429, throttling and dropped connections. */
export function isRetryableError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as {
    name?: string;
    code?: string;
    message?: string;
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const status = error.$metadata?.httpStatusCode;
  if (status !== undefined && (status >= 500 || status === 429)) {
    return true;
  }
  if (error.$retryable) {
    return true;
  }
  if (error.name !== undefined && RETRYABLE_ERROR_NAMES.has(error.name)) {
    return true;
  }
  if (error.code !== undefined && RETRYABLE_NETWORK_CODES.has(error.code)) {
    return true;
  }
  return /socket hang up|premature close/i.test(error.message ?? '');
}

/**
 * True only for network and stream failures the SDK has not retried itself. Errors that passed
 * through the SDK carry `$metadata` (an HTTP status or an attempt count) and already used every
 * attempt the client allows, so retrying the whole stream again would multiply the requests.
 */
export function isRetryableStreamError(err: unknown): boolean {
  if (!isRetryableError(err)) {
    return false;
  }
  const metadata = (err as { $metadata?: { httpStatusCode?: number; attempts?: number } })
    .$metadata;
  return metadata?.httpStatusCode === undefined && metadata?.attempts === undefined;
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retries = Math.max(0, options.retries);
  const minTimeout = options.minTimeoutMs ?? 1000;
  const factor = options.factor ?? 2;
  const maxJitter = options.maxJitterMs ?? 500;
  const shouldRetry = options.shouldRetry ?? isRetryableError;
  const opName = options.operationName || 'S3 operation';

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (attempt > retries || !shouldRetry(err)) {
        throw err;
      }
      const delay = Math.round(minTimeout * factor ** (attempt - 1) + Math.random() * maxJitter);
      const message = err instanceof Error ? err.message : String(err);
      log.info(
        `${opName}: attempt ${attempt}/${retries + 1} failed: ${message}. Retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
