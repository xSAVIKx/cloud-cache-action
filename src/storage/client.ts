import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { getHost } from '../ci/host';
import { log } from '../ci/log';
import { ProviderConfig, isKnownProvider, resolveProviderDefaults } from './providers';
import { getInputWithEnv, getInputAsBool } from '../utils/inputUtils';
import { Inputs } from '../constants';
import { annotateS3Error, s3ErrorReason, s3RequestLabel, type S3Request } from './errors';

export interface StorageContext {
  client: S3Client;
  providerConfig: ProviderConfig;
  bucket: string;
  /**
   * Set by `saveToS3` once this context's server has rejected a conditional (`If-None-Match`)
   * upload as unsupported, so later uploads through the same context skip the condition instead
   * of failing the same way again.
   */
  conditionalWriteUnsupported?: boolean;
  /** Set once this context's server has rejected object tagging, so later uploads omit tags. */
  objectTaggingUnsupported?: boolean;
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const CONTENT_SHA256_HEADER = 'x-amz-content-sha256';
const UNSIGNED_PAYLOAD_MIDDLEWARE = 'cloudCacheUnsignedPayload';
/** Commands that carry the large upload bodies. */
const UNSIGNED_PAYLOAD_COMMANDS = new Set(['UploadPartCommand', 'PutObjectCommand']);
/**
 * S3 error codes that can mean the server refuses `UNSIGNED-PAYLOAD`. `SignatureDoesNotMatch`
 * is also the code for wrong credentials. In that case the signed retry fails with the same
 * error, so the cost is one request.
 */
const UNSIGNED_PAYLOAD_REFUSALS = new Set([
  'XAmzContentSHA256Mismatch',
  'InvalidRequest',
  'NotImplemented',
  'SignatureDoesNotMatch',
]);

/**
 * Decides whether upload requests carry `UNSIGNED-PAYLOAD` instead of a payload hash. The action
 * checks its own sha256 on restore, and TLS protects the bytes in transit. Over plain HTTP the
 * payload hash is the only integrity in transit, so the default is off there.
 * `CLOUD_CACHE_UNSIGNED_PAYLOAD` overrides the default with `true` or `false`.
 */
export function useUnsignedPayload(
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const override = env.CLOUD_CACHE_UNSIGNED_PAYLOAD?.trim().toLowerCase();
  if (override === 'true') {
    return true;
  }
  if (override === 'false') {
    return false;
  }
  return !endpoint || endpoint.startsWith('https://');
}

/**
 * Decides whether the SDK adds its own CRC checksums where an operation allows them. The default
 * is off: the sha256 check on restore covers the archive, and the CRC32 costs main-thread CPU.
 * `CLOUD_CACHE_SDK_CHECKSUMS=true` turns them back on, for example for an AWS bucket with an
 * Object Lock default retention, which requires a checksum on each upload.
 */
export function useSdkChecksums(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLOUD_CACHE_SDK_CHECKSUMS?.trim().toLowerCase() === 'true';
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 120_000;

function timeoutFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  if (/^\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  log.warning(
    `Ignoring ${name}="${raw}": it must be a whole number of milliseconds (0 turns the timeout off). Using ${fallback}.`
  );
  return fallback;
}

/**
 * The timeouts of the S3 client's HTTP handler. Without them, an endpoint that does not answer
 * holds each attempt for the TCP connect timeout of the OS (about 130 s on Linux), and a stalled
 * response body holds a transfer with no limit.
 *
 * - `connectionTimeout` (10 s): a TCP connection that is not open by then fails, and the SDK
 *   tries again.
 * - `socketTimeout` (120 s): a socket with no data in either direction for this time fails, and
 *   the SDK or the part retry tries again. `addBodyIdleTimeout` applies the same limit to a
 *   response body. It is an idle limit, not a total limit, so a long transfer that moves data
 *   never hits it. It is long, so that tar back-pressure on a streaming restore, or a slow server
 *   reply to CompleteMultipartUpload, does not cause a false retry.
 *
 * `CLOUD_CACHE_CONNECTION_TIMEOUT_MS` and `CLOUD_CACHE_SOCKET_TIMEOUT_MS` override the defaults.
 * The value 0 turns the timeout off.
 */
export function storageTimeouts(env: NodeJS.ProcessEnv = process.env): {
  connectionTimeout: number;
  socketTimeout: number;
} {
  return {
    connectionTimeout: timeoutFromEnv(
      env,
      'CLOUD_CACHE_CONNECTION_TIMEOUT_MS',
      DEFAULT_CONNECTION_TIMEOUT_MS
    ),
    socketTimeout: timeoutFromEnv(env, 'CLOUD_CACHE_SOCKET_TIMEOUT_MS', DEFAULT_SOCKET_TIMEOUT_MS),
  };
}

/**
 * Returns the S3 error code when the error is a refusal of `UNSIGNED-PAYLOAD`, and undefined
 * otherwise. The SDK always sets `name`, so `name` and `Code` are checked separately.
 */
function unsignedPayloadRefusal(error: unknown): string | undefined {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  if (status !== 400 && status !== 403) {
    return undefined;
  }
  return [e?.name, e?.Code].find(
    (code): code is string => code !== undefined && UNSIGNED_PAYLOAD_REFUSALS.has(code)
  );
}

/**
 * Adds the `UNSIGNED-PAYLOAD` middleware. SigV4 then skips the second hash pass over each part.
 * When the server refuses the header, the middleware turns off for this client and sends the
 * request again with a signed payload.
 */
function addUnsignedPayloadMiddleware(client: S3Client): void {
  let enabled = true;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const request = args.request as { headers?: Record<string, string> } | undefined;
      const applies = UNSIGNED_PAYLOAD_COMMANDS.has(context.commandName ?? '');
      if (!enabled || !applies || !request?.headers) {
        return next(args);
      }
      request.headers[CONTENT_SHA256_HEADER] = UNSIGNED_PAYLOAD;
      try {
        return await next(args);
      } catch (error) {
        const code = unsignedPayloadRefusal(error);
        if (code === undefined) {
          throw error;
        }
        if (enabled) {
          enabled = false;
          log.info(
            `The server refused UNSIGNED-PAYLOAD (${code}). Uploads for this client now sign the payload hash.`
          );
        }
        delete request.headers[CONTENT_SHA256_HEADER];
        return next(args);
      }
    },
    { step: 'build', name: UNSIGNED_PAYLOAD_MIDDLEWARE }
  );
}

const GCS_GENERATION_HEADER = 'x-goog-generation';
const GCS_GENERATION_MIDDLEWARE = 'cloudCacheGcsGeneration';
/** Commands that write an object, whose generation the metadata copy pins its source to. */
const OBJECT_WRITE_COMMANDS = new Set(['PutObjectCommand', 'CompleteMultipartUploadCommand']);

/**
 * Reports the generation that GCS gives each written object as its `VersionId`, as GCS maps
 * `x-amz-version-id` to `x-goog-generation`. The SDK reads only the `x-amz-*` header, so without
 * this a write on GCS has no version id.
 */
function addGcsGenerationMiddleware(client: S3Client): void {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args);
      if (!OBJECT_WRITE_COMMANDS.has(context.commandName ?? '')) {
        return result;
      }
      const headers = (result.response as { headers?: Record<string, string> } | undefined)
        ?.headers;
      const generation = headers?.[GCS_GENERATION_HEADER];
      const output = result.output as { VersionId?: string };
      if (generation && output.VersionId === undefined) {
        output.VersionId = generation;
      }
      return result;
    },
    { step: 'build', name: GCS_GENERATION_MIDDLEWARE }
  );
}

const ERROR_MESSAGE_MIDDLEWARE = 'cloudCacheErrorMessage';
const ATTEMPT_MIDDLEWARE = 'cloudCacheAttempt';
const BODY_TIMEOUT_MIDDLEWARE = 'cloudCacheBodyTimeout';

/** The request a failed attempt made and how long the attempt took, by error object. */
const attemptFailures = new WeakMap<object, { request: S3Request; durationMs: number }>();

function s3RequestOf(commandName: string | undefined, input: unknown): S3Request {
  const { Bucket, Key } = (input ?? {}) as { Bucket?: string; Key?: string };
  return {
    operation: (commandName ?? 'S3 request').replace(/Command$/, ''),
    bucket: Bucket,
    key: Key,
  };
}

/**
 * Gives every failed request an error message that names the operation and the object (see
 * `annotateS3Error`). An inner middleware also records each failed attempt, so the retry log
 * line can name the request.
 */
function addErrorMiddleware(client: S3Client): void {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      try {
        return await next(args);
      } catch (error) {
        annotateS3Error(error, s3RequestOf(context.commandName, args.input));
        throw error;
      }
    },
    { step: 'initialize', name: ERROR_MESSAGE_MIDDLEWARE, priority: 'high' }
  );
  // In the finalizeRequest step, a lower priority than the SDK retry middleware ('high') puts
  // this one inside the retry loop, so it sees each attempt.
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const start = Date.now();
      try {
        return await next(args);
      } catch (error) {
        if (typeof error === 'object' && error !== null) {
          attemptFailures.set(error, {
            request: s3RequestOf(context.commandName, args.input),
            durationMs: Date.now() - start,
          });
        }
        throw error;
      }
    },
    { step: 'finalizeRequest', name: ATTEMPT_MIDDLEWARE, priority: 'normal' }
  );
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The part of a Node.js `IncomingMessage` that the body idle timeout uses. */
interface ResponseBody {
  complete?: boolean;
  socket?: unknown;
  setTimeout(ms: number, callback: () => void): unknown;
  destroy(error: Error): unknown;
}

function isResponseBody(body: unknown): body is ResponseBody {
  const candidate = body as Partial<ResponseBody> | undefined;
  return typeof candidate?.setTimeout === 'function' && typeof candidate.destroy === 'function';
}

/**
 * Stops a response body that sends no data for `timeoutMs`. The SDK `socketTimeout` does not do
 * this for a value of 6 s or more: it starts its timer after 3 s and clears it when the response
 * headers arrive. A GetObject body that stalls after the headers would then wait with no limit.
 * The error is a `TimeoutError` with no `$metadata`, so the part retry tries the part again.
 */
function addBodyIdleTimeout(client: S3Client, timeoutMs: number): void {
  if (timeoutMs <= 0) {
    return;
  }
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args);
      const body = (result.response as { body?: unknown } | undefined)?.body;
      if (isResponseBody(body) && body.socket && !body.complete) {
        const label = s3RequestLabel(s3RequestOf(context.commandName, args.input));
        body.setTimeout(timeoutMs, () => {
          body.destroy(
            Object.assign(
              new Error(`${label}: no data from the server for ${seconds(timeoutMs)}`),
              {
                name: 'TimeoutError',
                code: 'ETIMEDOUT',
              }
            )
          );
        });
      }
      return result;
    },
    { step: 'finalizeRequest', name: BODY_TIMEOUT_MIDDLEWARE, priority: 'normal' }
  );
}

type AnyRetryStrategy = Awaited<ReturnType<S3Client['config']['retryStrategy']>>;
type RetryStrategyV2 = Extract<AnyRetryStrategy, { refreshRetryTokenForRetry: unknown }>;
type RetryToken = Parameters<RetryStrategyV2['recordSuccess']>[0];
type RetryErrorInfo = Parameters<RetryStrategyV2['refreshRetryTokenForRetry']>[1];

/**
 * Wraps the SDK retry strategy and logs one line for each retry it grants. Without the line, a
 * job log shows nothing while the SDK tries an endpoint that does not answer again and again.
 * The SDK waits inside `refreshRetryTokenForRetry`, so the line comes just before the next attempt.
 */
class LoggedRetryStrategy {
  constructor(
    private readonly inner: RetryStrategyV2,
    private readonly maxAttempts: number
  ) {}

  get mode(): string | undefined {
    return (this.inner as { mode?: string }).mode;
  }

  acquireInitialRetryToken(scope: string): Promise<RetryToken> {
    return this.inner.acquireInitialRetryToken(scope);
  }

  recordSuccess(token: RetryToken): void {
    this.inner.recordSuccess(token);
  }

  async refreshRetryTokenForRetry(token: RetryToken, info: RetryErrorInfo): Promise<RetryToken> {
    const next = await this.inner.refreshRetryTokenForRetry(token, info);
    const failure = info.error ? attemptFailures.get(info.error) : undefined;
    const label = s3RequestLabel(failure?.request ?? { operation: 'S3 request' });
    const failed = token.getRetryCount() + 1;
    const took = failure === undefined ? '' : ` after ${seconds(failure.durationMs)}`;
    const wait =
      (next as { $retryLog?: { acquisitionDelay?: number } }).$retryLog?.acquisitionDelay ??
      next.getRetryDelay();
    log.info(
      `${label}: attempt ${failed} of ${this.maxAttempts} failed${took}: ${s3ErrorReason(info.error).replace(/\.$/, '')}. Starting attempt ${failed + 1} after a wait of ${seconds(wait)}.`
    );
    return next;
  }
}

function logSdkRetries(client: S3Client, maxAttempts: number): void {
  const resolve = client.config.retryStrategy;
  let logged: Promise<AnyRetryStrategy> | undefined;
  client.config.retryStrategy = () => {
    logged ??= resolve().then((strategy) =>
      'refreshRetryTokenForRetry' in strategy
        ? new LoggedRetryStrategy(strategy, maxAttempts)
        : strategy
    );
    return logged;
  };
}

export interface StorageClientOptions {
  /** Total SDK attempts per request, including the first one. */
  maxAttempts: number;
}

export function createStorageContext(options: StorageClientOptions): StorageContext {
  const bucket = getInputWithEnv(Inputs.Bucket, ['AWS_S3_BUCKET', 'S3_BUCKET']);
  if (!bucket) {
    throw new Error(
      'Bucket name is required. Please set "bucket" input or AWS_S3_BUCKET environment variable.'
    );
  }

  const endpointInput = getInputWithEnv(Inputs.Endpoint, [
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_S3',
  ]);
  const regionInput = getInputWithEnv(Inputs.Region, ['AWS_REGION', 'AWS_DEFAULT_REGION']);
  const providerInput = getHost().input(Inputs.Provider);
  if (providerInput && !isKnownProvider(providerInput)) {
    log.warning(`Unknown provider "${providerInput}"; using generic S3-compatible defaults.`);
  }

  const forcePathStyleRaw = getHost().input(Inputs.ForcePathStyle);
  const forcePathStyleInput =
    forcePathStyleRaw !== '' ? getInputAsBool(Inputs.ForcePathStyle) : undefined;

  const providerConfig = resolveProviderDefaults(
    endpointInput,
    regionInput,
    forcePathStyleInput,
    providerInput
  );

  const accessKey = getInputWithEnv(Inputs.AccessKey, ['AWS_ACCESS_KEY_ID'], Inputs.AccessKeyCamel);
  const secretKey = getInputWithEnv(
    Inputs.SecretKey,
    ['AWS_SECRET_ACCESS_KEY'],
    Inputs.SecretKeyCamel
  );
  const sessionToken = getInputWithEnv(
    Inputs.SessionToken,
    ['AWS_SESSION_TOKEN'],
    Inputs.SessionTokenCamel
  );

  const maxAttempts = Math.max(1, options.maxAttempts);
  const timeouts = storageTimeouts();
  const clientConfig: S3ClientConfig = {
    region: providerConfig.region,
    forcePathStyle: providerConfig.forcePathStyle,
    maxAttempts,
    retryMode: 'standard',
    requestHandler: timeouts,
  };

  if (providerConfig.endpoint) {
    clientConfig.endpoint = providerConfig.endpoint;
  }

  // Several S3-compatible services reject the CRC checksums the SDK sends by default. On AWS the
  // CRC32 costs about 100 ms of main-thread CPU per 64 MiB part, and the sha256 check on restore
  // already covers the archive, so no provider sends a checksum unless the operation needs one.
  if (!useSdkChecksums()) {
    clientConfig.requestChecksumCalculation = 'WHEN_REQUIRED';
    clientConfig.responseChecksumValidation = 'WHEN_REQUIRED';
  }

  if (accessKey && secretKey) {
    clientConfig.credentials = {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      sessionToken: sessionToken || undefined,
    };
  } else if (accessKey || secretKey) {
    log.warning(
      'Only one of access-key and secret-key is set; ignoring it and using the default AWS credential chain.'
    );
  }

  log.debug(
    `Configuring S3 client for provider: ${providerConfig.provider} (endpoint: ${
      providerConfig.endpoint || 'AWS default'
    }, region: ${providerConfig.region}, forcePathStyle: ${providerConfig.forcePathStyle}, maxAttempts: ${maxAttempts}, connectionTimeout: ${timeouts.connectionTimeout} ms, socketTimeout: ${timeouts.socketTimeout} ms)`
  );

  const client = new S3Client(clientConfig);
  addErrorMiddleware(client);
  addBodyIdleTimeout(client, timeouts.socketTimeout);
  logSdkRetries(client, maxAttempts);
  if (useUnsignedPayload(providerConfig.endpoint)) {
    addUnsignedPayloadMiddleware(client);
  }
  if (providerConfig.provider === 'gcs') {
    addGcsGenerationMiddleware(client);
  }

  return {
    client,
    providerConfig,
    bucket,
  };
}
