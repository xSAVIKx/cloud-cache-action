/**
 * S3 also answers 403 when the credentials themselves are wrong: a bad key, a bad signature, a
 * clock skew or an expired session token. Those errors are not a missing write permission, so a
 * hint about read-only would mislead.
 */
const CREDENTIAL_ERROR_NAMES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'RequestTimeTooSkewed',
  'ExpiredToken',
  'InvalidToken',
  'TokenRefreshRequired',
]);

/**
 * True when S3 refused the request because the credentials do not have the permission: the error
 * name `AccessDenied`, or an HTTP 403 that is not a credential error. The check follows the
 * `cause` chain, because some callers wrap the SDK error.
 */
export function isAccessDeniedError(err: unknown): boolean {
  for (let current = err, depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) {
      return false;
    }
    const error = current as {
      name?: string;
      cause?: unknown;
      $metadata?: { httpStatusCode?: number };
    };
    if (error.name !== undefined && CREDENTIAL_ERROR_NAMES.has(error.name)) {
      return false;
    }
    if (error.name === 'AccessDenied' || error.$metadata?.httpStatusCode === 403) {
      return true;
    }
    current = error.cause;
  }
  return false;
}

/** One S3 request, as an error message names it. */
export interface S3Request {
  /** The command name without `Command`, for example `HeadObject`. */
  operation: string;
  bucket?: string;
  key?: string;
}

/** The S3 calls that write. A 403 from one of them can come from a read-only credential. */
const WRITE_OPERATIONS = new Set([
  'PutObject',
  'CreateMultipartUpload',
  'UploadPart',
  'CompleteMultipartUpload',
  'CopyObject',
]);

/** The policy actions each S3 call needs, as the Security guide lists them. */
const REQUIRED_PERMISSIONS: Record<string, string> = {
  HeadObject: 's3:ListBucket on the bucket and s3:GetObject on the cache keys',
  GetObject: 's3:GetObject on the cache keys',
  GetObjectTagging: 's3:GetObjectTagging on the cache keys',
  ListObjectsV2: 's3:ListBucket on the bucket',
  PutObject: 's3:PutObject on the cache keys',
  CreateMultipartUpload: 's3:PutObject on the cache keys',
  UploadPart: 's3:PutObject on the cache keys',
  CompleteMultipartUpload: 's3:PutObject on the cache keys',
  CopyObject: 's3:GetObject and s3:PutObject on the cache keys',
  PutObjectTagging: 's3:PutObjectTagging on the cache keys',
  AbortMultipartUpload: 's3:AbortMultipartUpload on the cache keys',
  ListMultipartUploads: 's3:ListBucketMultipartUploads on the bucket',
  DeleteObject: 's3:DeleteObject on the cache keys',
};

/** Messages that tell the reader nothing: the SDK gives them when a response has no body. */
const EMPTY_MESSAGES = new Set(['', 'UnknownError', 'Unknown']);
/** Error names that are not an S3 error code. */
const GENERIC_NAMES = new Set(['Unknown', 'Error', 'S3ServiceException']);

const STATUS_TEXT: Record<number, string> = {
  301: 'Moved Permanently',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  412: 'Precondition Failed',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const REDIRECT_HINT =
  'The bucket is probably in another region. Set the region input to the bucket region. S3 gives this region in the x-amz-bucket-region response header.';

interface SdkError {
  name?: string;
  message?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number; attempts?: number };
}

/** `HTTP 403 Forbidden`, or `HTTP 418` for a status with no known text. */
export function httpStatusText(status: number): string {
  const text = STATUS_TEXT[status];
  return text ? `HTTP ${status} ${text}` : `HTTP ${status}`;
}

/** The error message, or undefined when the SDK had no message to give. */
export function usefulMessage(err: unknown): string | undefined {
  const message = (err as SdkError | undefined)?.message?.trim() ?? '';
  return EMPTY_MESSAGES.has(message) ? undefined : message;
}

/** `HeadObject s3://bucket/key`: the operation and the object of a request. */
export function s3RequestLabel(request: S3Request): string {
  if (!request.bucket) {
    return request.operation;
  }
  const path = request.key ? `${request.bucket}/${request.key}` : request.bucket;
  return `${request.operation} s3://${path}`;
}

/** A short reason for a failed attempt: the S3 message, or else the HTTP status. */
export function s3ErrorReason(err: unknown): string {
  const status = (err as SdkError | undefined)?.$metadata?.httpStatusCode;
  const message = usefulMessage(err);
  if (message !== undefined) {
    return message;
  }
  return status === undefined
    ? String((err as SdkError | undefined)?.name ?? err)
    : httpStatusText(status);
}

function accessHint(request: S3Request, credentialError: boolean): string {
  if (credentialError) {
    return 'Check access-key, secret-key, session-token and region.';
  }
  const permission = REQUIRED_PERMISSIONS[request.operation] ?? `the ${request.operation} call`;
  return `Check access-key, secret-key and region, and check that the bucket policy allows ${permission}. The Security guide lists the permission for each S3 call.`;
}

/**
 * The message for a failed S3 request. A 403 gets the operation, the object, the status and a
 * likely fix. An error with no message (a `HEAD` response has no body, so the SDK says
 * `UnknownError`) gets the operation, the object and the status. A network error after SDK
 * retries gets the operation and the attempt count. Other messages stay as they are.
 */
export function s3ErrorMessage(err: unknown, request: S3Request): string {
  const error = (typeof err === 'object' && err !== null ? err : {}) as SdkError;
  const message = usefulMessage(error);
  const status = error.$metadata?.httpStatusCode;
  const attempts = error.$metadata?.attempts ?? 1;
  const afterAttempts = attempts > 1 ? ` after ${attempts} attempts` : '';

  if (status === undefined) {
    if (message !== undefined && attempts > 1) {
      return `${s3RequestLabel(request)} failed${afterAttempts}: ${message}`;
    }
    return error.message ?? String(err);
  }
  if (status === 301 && message === undefined) {
    return `${s3RequestLabel(request)} returned ${httpStatusText(status)}${afterAttempts}. ${REDIRECT_HINT}`;
  }
  if (status !== 403) {
    return (
      message ?? `${s3RequestLabel(request)} returned ${httpStatusText(status)}${afterAttempts}`
    );
  }

  const code = [error.Code, error.name].find(
    (name): name is string => !!name && !GENERIC_NAMES.has(name)
  );
  const detail = message === undefined || message === code ? '' : `: ${message.replace(/\.$/, '')}`;
  const codeText = code === undefined ? '' : ` (${code})`;
  const credentialError = code !== undefined && CREDENTIAL_ERROR_NAMES.has(code);
  return `${s3RequestLabel(request)} returned ${httpStatusText(403)}${detail}${codeText}. ${accessHint(request, credentialError)}`;
}

const S3_REQUEST = Symbol('cloudCacheS3Request');

/**
 * Records the request on the error and rewrites its message with `s3ErrorMessage`. The name, the
 * code and `$metadata` stay, so the checks that read them give the same result.
 */
export function annotateS3Error(err: unknown, request: S3Request): void {
  if (typeof err !== 'object' || err === null || S3_REQUEST in err) {
    return;
  }
  const message = s3ErrorMessage(err, request);
  Object.defineProperty(err, S3_REQUEST, { value: request });
  if (err instanceof Error && message !== err.message) {
    err.message = message;
  }
}

/** The S3 operation that `annotateS3Error` recorded on the error or on one of its causes. */
export function s3OperationOf(err: unknown): string | undefined {
  for (let current = err, depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    const request = (current as { [S3_REQUEST]?: S3Request })[S3_REQUEST];
    if (request) {
      return request.operation;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * True when S3 refused a write call for a missing permission. Only then can `read-only: true` be
 * the fix: a 403 on a read call or a credential error means a broken setup.
 */
export function isWriteAccessDeniedError(err: unknown): boolean {
  const operation = s3OperationOf(err);
  return operation !== undefined && WRITE_OPERATIONS.has(operation) && isAccessDeniedError(err);
}
