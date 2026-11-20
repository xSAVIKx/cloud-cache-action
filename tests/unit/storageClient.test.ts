import { jest } from '@jest/globals';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Inputs } from '../../src/constants';

const mockGetInput = jest.fn<(name: string) => string>();
const mockDebug = jest.fn<(message: string) => void>();
const mockWarning = jest.fn<(message: string) => void>();
const mockInfo = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: mockGetInput,
  debug: mockDebug,
  warning: mockWarning,
  info: mockInfo,
}));

const { CompleteMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, UploadPartCommand } =
  await import('@aws-sdk/client-s3');
const { createStorageContext, storageTimeouts, useSdkChecksums, useUnsignedPayload } = await import(
  '../../src/storage/client'
);

describe('Storage Client Context Factory', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockGetInput.mockReturnValue('');
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws an error if bucket name is not provided', () => {
    delete process.env.AWS_S3_BUCKET;
    delete process.env.S3_BUCKET;

    expect(() => createStorageContext({ maxAttempts: 1 })).toThrow('Bucket name is required');
  });

  it('initializes client from input parameters', () => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case Inputs.Bucket:
          return 'my-test-bucket';
        case Inputs.Region:
          return 'eu-central-1';
        case Inputs.Endpoint:
          return 'https://s3.eu-central-1.amazonaws.com';
        case Inputs.AccessKey:
          return 'MOCK_KEY';
        case Inputs.SecretKey:
          return 'MOCK_SECRET';
        case Inputs.SessionToken:
          return 'MOCK_TOKEN';
        case Inputs.ForcePathStyle:
          return 'true';
        default:
          return '';
      }
    });

    const context = createStorageContext({ maxAttempts: 1 });

    expect(context.bucket).toBe('my-test-bucket');
    expect(context.providerConfig.region).toBe('eu-central-1');
    expect(context.providerConfig.forcePathStyle).toBe(true);
    expect(context.client).toBeDefined();
  });

  it('falls back to environment variables when inputs are missing', () => {
    process.env.AWS_S3_BUCKET = 'env-bucket';
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_ACCESS_KEY_ID = 'ENV_KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'ENV_SECRET';

    const context = createStorageContext({ maxAttempts: 1 });

    expect(context.bucket).toBe('env-bucket');
    expect(context.providerConfig.region).toBe('us-west-2');
  });

  it('handles custom S3-compatible provider endpoint without explicit credentials', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Bucket) return 'garage-bucket';
      if (name === Inputs.Endpoint) return 'http://127.0.0.1:3900';
      return '';
    });

    const context = createStorageContext({ maxAttempts: 1 });

    expect(context.bucket).toBe('garage-bucket');
    expect(context.providerConfig.provider).toBe('garage');
    expect(context.providerConfig.forcePathStyle).toBe(true);
  });

  const inputsOf =
    (values: Record<string, string>) =>
    (name: string): string =>
      values[name] ?? '';

  describe('endpoint from the environment', () => {
    const endpointOf = async (): Promise<string | undefined> => {
      const { client } = createStorageContext({ maxAttempts: 1 });
      const endpoint = await client.config.endpoint?.();
      return endpoint && `${endpoint.protocol}//${endpoint.hostname}`;
    };

    beforeEach(() => {
      delete process.env.AWS_ENDPOINT_URL;
      delete process.env.AWS_ENDPOINT_URL_S3;
      mockGetInput.mockImplementation(inputsOf({ [Inputs.Bucket]: 'bucket' }));
    });

    it('prefers AWS_ENDPOINT_URL_S3 over AWS_ENDPOINT_URL', async () => {
      process.env.AWS_ENDPOINT_URL = 'http://localstack.test:4566';
      process.env.AWS_ENDPOINT_URL_S3 = 'https://r2.test';
      await expect(endpointOf()).resolves.toBe('https://r2.test');
    });

    it('uses AWS_ENDPOINT_URL when AWS_ENDPOINT_URL_S3 is not set', async () => {
      process.env.AWS_ENDPOINT_URL = 'http://localstack.test:4566';
      await expect(endpointOf()).resolves.toBe('http://localstack.test');
    });
  });

  describe('region redirects', () => {
    it('follows them on AWS when no endpoint is set', () => {
      delete process.env.AWS_ENDPOINT_URL;
      delete process.env.AWS_ENDPOINT_URL_S3;
      mockGetInput.mockImplementation(inputsOf({ [Inputs.Bucket]: 'bucket' }));
      const { client } = createStorageContext({ maxAttempts: 1 });
      expect(client.config.followRegionRedirects).toBe(true);
    });

    it('does not follow them with an explicit endpoint', () => {
      mockGetInput.mockImplementation(
        inputsOf({ [Inputs.Bucket]: 'bucket', [Inputs.Endpoint]: 'https://s3.example.test' })
      );
      const { client } = createStorageContext({ maxAttempts: 1 });
      expect(client.config.followRegionRedirects).toBeFalsy();
    });
  });

  it('passes the attempt count and standard retry mode to the SDK', async () => {
    mockGetInput.mockImplementation(inputsOf({ [Inputs.Bucket]: 'bucket' }));
    const { client } = createStorageContext({ maxAttempts: 4 });
    await expect(client.config.maxAttempts()).resolves.toBe(4);
    expect(client.config.retryMode).toBe('standard');
  });

  it('only sends checksums when required for S3-compatible providers', async () => {
    mockGetInput.mockImplementation(
      inputsOf({ [Inputs.Bucket]: 'bucket', [Inputs.Endpoint]: 'https://storage.googleapis.com' })
    );
    const { client } = createStorageContext({ maxAttempts: 1 });
    await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
    await expect(client.config.responseChecksumValidation()).resolves.toBe('WHEN_REQUIRED');
  });

  it('only sends checksums when required for AWS too', async () => {
    mockGetInput.mockImplementation(inputsOf({ [Inputs.Bucket]: 'bucket' }));
    const { client } = createStorageContext({ maxAttempts: 1 });
    await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
    await expect(client.config.responseChecksumValidation()).resolves.toBe('WHEN_REQUIRED');
  });

  it('keeps the SDK checksum defaults when CLOUD_CACHE_SDK_CHECKSUMS is true', async () => {
    mockGetInput.mockImplementation(inputsOf({ [Inputs.Bucket]: 'bucket' }));
    process.env.CLOUD_CACHE_SDK_CHECKSUMS = 'true';
    try {
      const { client } = createStorageContext({ maxAttempts: 1 });
      await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_SUPPORTED');
      await expect(client.config.responseChecksumValidation()).resolves.toBe('WHEN_SUPPORTED');
    } finally {
      delete process.env.CLOUD_CACHE_SDK_CHECKSUMS;
    }
  });

  it.each([
    [undefined, false],
    ['true', true],
    [' TRUE ', true],
    ['false', false],
    ['yes', false],
  ])('reads CLOUD_CACHE_SDK_CHECKSUMS=%p as %p', (value, expected) => {
    expect(useSdkChecksums(value === undefined ? {} : { CLOUD_CACHE_SDK_CHECKSUMS: value })).toBe(
      expected
    );
  });

  it('warns about an unknown provider', () => {
    mockGetInput.mockImplementation(
      inputsOf({ [Inputs.Bucket]: 'bucket', [Inputs.Provider]: 'cloudflare-r2' })
    );
    const { providerConfig } = createStorageContext({ maxAttempts: 1 });
    expect(providerConfig.provider).toBe('generic-s3');
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Unknown provider "cloudflare-r2"')
    );
  });

  it('warns when only one of access-key and secret-key is set', () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    mockGetInput.mockImplementation(
      inputsOf({ [Inputs.Bucket]: 'bucket', [Inputs.AccessKey]: 'only-the-id' })
    );
    createStorageContext({ maxAttempts: 1 });
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Only one of access-key and secret-key is set')
    );
  });

  it('warns when only secret-key is set', () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    mockGetInput.mockImplementation(
      inputsOf({ [Inputs.Bucket]: 'bucket', [Inputs.SecretKey]: 'only-the-secret' })
    );
    createStorageContext({ maxAttempts: 1 });
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Only one of access-key and secret-key is set')
    );
  });
});

describe('useUnsignedPayload', () => {
  it.each([
    [undefined, {}, true],
    ['https://x.r2.cloudflarestorage.com', {}, true],
    ['http://127.0.0.1:9000', {}, false],
    ['http://127.0.0.1:9000', { CLOUD_CACHE_UNSIGNED_PAYLOAD: 'true' }, true],
    ['https://s3.example', { CLOUD_CACHE_UNSIGNED_PAYLOAD: 'false' }, false],
    ['https://s3.example', { CLOUD_CACHE_UNSIGNED_PAYLOAD: 'maybe' }, true],
  ])('endpoint %s with %j gives %s', (endpoint, env, expected) => {
    expect(useUnsignedPayload(endpoint, env)).toBe(expected);
  });
});

describe('UNSIGNED-PAYLOAD middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CLOUD_CACHE_UNSIGNED_PAYLOAD;
    mockGetInput.mockImplementation((name: string) => {
      const values: Record<string, string> = {
        [Inputs.Bucket]: 'b',
        [Inputs.Endpoint]: 'https://s3.example.test',
        [Inputs.AccessKey]: 'K',
        [Inputs.SecretKey]: 'S',
      };
      return values[name] ?? '';
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  /**
   * Replaces the network with a fake handler. `respond` sees the request headers and either
   * returns or throws; the headers of every request are recorded in order.
   */
  function stubNetwork(
    client: ReturnType<typeof createStorageContext>['client'],
    respond: (headers: Record<string, string>) => void
  ): Array<Record<string, string>> {
    const seen: Array<Record<string, string>> = [];
    client.middlewareStack.add(
      (_next) => async (args) => {
        const headers = { ...(args.request as { headers: Record<string, string> }).headers };
        seen.push(headers);
        respond(headers);
        return { output: { $metadata: {} }, response: {} } as never;
      },
      { step: 'finalizeRequest', name: 'fakeNetwork', priority: 'low' }
    );
    return seen;
  }

  const part = () =>
    new UploadPartCommand({
      Bucket: 'b',
      Key: 'k',
      UploadId: 'u',
      PartNumber: 1,
      Body: Buffer.from('x'),
    });
  const refusal = (name: string, status = 400) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it('sets the header on UploadPart and not on HeadObject', async () => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, () => undefined);

    await client.send(part());
    await client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }));

    expect(seen[0]['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(seen[1]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
  });

  it('does not add the middleware over plain HTTP', async () => {
    mockGetInput.mockImplementation((name: string) => {
      const values: Record<string, string> = {
        [Inputs.Bucket]: 'b',
        [Inputs.Endpoint]: 'http://127.0.0.1:9000',
        [Inputs.AccessKey]: 'K',
        [Inputs.SecretKey]: 'S',
      };
      return values[name] ?? '';
    });
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, () => undefined);

    await client.send(part());

    expect(seen[0]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
  });

  it.each([
    ['XAmzContentSHA256Mismatch', 400],
    ['InvalidRequest', 400],
    ['NotImplemented', 403],
    ['SignatureDoesNotMatch', 403],
  ])('retries once signed and stays signed after %s', async (code, status) => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, (headers) => {
      if (headers['x-amz-content-sha256'] === 'UNSIGNED-PAYLOAD') {
        throw refusal(code, status);
      }
    });

    await client.send(part());
    await client.send(part());

    expect(seen).toHaveLength(3);
    expect(seen[1]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
    expect(seen[2]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(mockInfo.mock.calls[0][0]).toContain(code);
  });

  it('finds the code in Code when name is generic, and logs that code', async () => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, (headers) => {
      if (headers['x-amz-content-sha256'] === 'UNSIGNED-PAYLOAD') {
        throw Object.assign(new Error('refused'), {
          name: 'S3ServiceException',
          Code: 'XAmzContentSHA256Mismatch',
          $metadata: { httpStatusCode: 400 },
        });
      }
    });

    await client.send(part());

    expect(seen).toHaveLength(2);
    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(mockInfo.mock.calls[0][0]).toContain('(XAmzContentSHA256Mismatch)');
    expect(mockInfo.mock.calls[0][0]).not.toContain('undefined');
  });

  it('fails when the signed retry fails with the same credential error', async () => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, () => {
      throw refusal('SignatureDoesNotMatch', 403);
    });

    await expect(client.send(part())).rejects.toThrow('SignatureDoesNotMatch');
    expect(seen).toHaveLength(2);
    expect(seen[1]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
  });

  it('does not retry other errors', async () => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, () => {
      throw refusal('AccessDenied', 403);
    });

    await expect(client.send(part())).rejects.toThrow('AccessDenied');
    expect(seen).toHaveLength(1);
    expect(mockInfo).not.toHaveBeenCalled();
  });
});

describe('GCS generation middleware', () => {
  const endpointInput = (endpoint: string) => (name: string) => {
    const values: Record<string, string> = {
      [Inputs.Bucket]: 'b',
      [Inputs.Endpoint]: endpoint,
      [Inputs.AccessKey]: 'K',
      [Inputs.SecretKey]: 'S',
    };
    return values[name] ?? '';
  };

  /** Replaces the network with a fake handler that answers with these response headers. */
  function answerWith(
    client: ReturnType<typeof createStorageContext>['client'],
    headers: Record<string, string>
  ): void {
    client.middlewareStack.add(
      (_next) => async () => ({ output: { $metadata: {} }, response: { headers } }) as never,
      { step: 'finalizeRequest', name: 'fakeNetwork', priority: 'low' }
    );
  }

  const complete = () =>
    new CompleteMultipartUploadCommand({ Bucket: 'b', Key: 'k', UploadId: 'u' });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports the x-goog-generation of a GCS write as the VersionId', async () => {
    mockGetInput.mockImplementation(endpointInput('https://storage.googleapis.com'));
    const { client } = createStorageContext({ maxAttempts: 1 });
    answerWith(client, { 'x-goog-generation': '1761234567890123' });

    const output = await client.send(complete());

    expect(output.VersionId).toBe('1761234567890123');
  });

  it('leaves the VersionId alone on other providers', async () => {
    mockGetInput.mockImplementation(endpointInput('https://s3.example.test'));
    const { client } = createStorageContext({ maxAttempts: 1 });
    answerWith(client, { 'x-goog-generation': '1761234567890123' });

    const output = await client.send(complete());

    expect(output.VersionId).toBeUndefined();
  });
});

describe('storageTimeouts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses a 10 s connection timeout and a 120 s socket idle timeout by default', () => {
    expect(storageTimeouts({})).toEqual({ connectionTimeout: 10_000, socketTimeout: 120_000 });
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('reads the two timeouts from the environment, in milliseconds', () => {
    expect(
      storageTimeouts({
        CLOUD_CACHE_CONNECTION_TIMEOUT_MS: ' 2500 ',
        CLOUD_CACHE_SOCKET_TIMEOUT_MS: '0',
      })
    ).toEqual({ connectionTimeout: 2500, socketTimeout: 0 });
  });

  it.each(['-1', 'ten', '1.5', ''])('warns and keeps the default for %p', (value) => {
    expect(storageTimeouts({ CLOUD_CACHE_SOCKET_TIMEOUT_MS: value }).socketTimeout).toBe(120_000);
    if (value === '') {
      expect(mockWarning).not.toHaveBeenCalled();
    } else {
      expect(mockWarning).toHaveBeenCalledWith(
        `Ignoring CLOUD_CACHE_SOCKET_TIMEOUT_MS="${value}": it must be a whole number of milliseconds (0 turns the timeout off). Using 120000.`
      );
    }
  });
});

describe('S3 client against a local HTTP server', () => {
  const originalEnv = process.env;
  let server: Server;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  const open: Set<import('node:net').Socket> = new Set();

  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res));
    server.on('connection', (socket) => {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    for (const socket of open) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CLOUD_CACHE_CONNECTION_TIMEOUT_MS;
    delete process.env.CLOUD_CACHE_SOCKET_TIMEOUT_MS;
    const { port } = server.address() as AddressInfo;
    mockGetInput.mockImplementation((name: string) => {
      const values: Record<string, string> = {
        [Inputs.Bucket]: 'b',
        [Inputs.Endpoint]: `http://127.0.0.1:${port}`,
        [Inputs.ForcePathStyle]: 'true',
        [Inputs.AccessKey]: 'K',
        [Inputs.SecretKey]: 'S',
      };
      return values[name] ?? '';
    });
  });

  const head = () => new HeadObjectCommand({ Bucket: 'b', Key: 'k' });

  it('gives the client the default timeouts', async () => {
    handler = (_req, res) => res.writeHead(200, { 'content-length': '0' }).end();
    const { client } = createStorageContext({ maxAttempts: 1 });
    await client.send(head());
    const config = (
      client.config.requestHandler as { httpHandlerConfigs(): Record<string, unknown> }
    ).httpHandlerConfigs();
    expect(config).toEqual(
      expect.objectContaining({ connectionTimeout: 10_000, socketTimeout: 120_000 })
    );
    client.destroy();
  });

  it('turns a 403 with no body on HeadObject into a message with the status and a fix', async () => {
    handler = (_req, res) => res.writeHead(403, { 'content-length': '0' }).end();
    const { client } = createStorageContext({ maxAttempts: 1 });
    const error = await client.send(head()).then(
      () => undefined,
      (err: unknown) => err as Error
    );
    expect(error?.message).toMatch(/^HeadObject s3:\/\/b\/k returned HTTP 403 Forbidden\. /);
    expect(error?.message).toContain('s3:ListBucket');
    expect(error?.message).not.toContain('UnknownError');
    client.destroy();
  });

  it('logs one line before each SDK retry, and then succeeds', async () => {
    let requests = 0;
    handler = (_req, res) => {
      requests++;
      res.writeHead(requests < 3 ? 503 : 200, { 'content-length': '0' }).end();
    };
    const { client } = createStorageContext({ maxAttempts: 4 });
    await client.send(head());
    expect(requests).toBe(3);
    const retryLines = mockInfo.mock.calls
      .map(([line]) => line)
      .filter((line) => line.startsWith('HeadObject s3://b/k: attempt'));
    expect(retryLines).toHaveLength(2);
    expect(retryLines[0]).toMatch(
      /^HeadObject s3:\/\/b\/k: attempt 1 of 4 failed after \d+\.\d s: HTTP 503 Service Unavailable\. Starting attempt 2 after a wait of \d+\.\d s\.$/
    );
    expect(retryLines[1]).toContain('attempt 2 of 4 failed');
    client.destroy();
  });

  it('logs no retry line for an error the SDK does not retry', async () => {
    handler = (_req, res) => res.writeHead(403, { 'content-length': '0' }).end();
    const { client } = createStorageContext({ maxAttempts: 4 });
    await expect(client.send(head())).rejects.toThrow('HTTP 403');
    expect(mockInfo).not.toHaveBeenCalledWith(expect.stringContaining('attempt 1 of 4'));
    client.destroy();
  });

  // The SDK applies a socket timeout of 6 s or more only until the response headers arrive, so
  // this test needs a value above 6 s to show that a stalled body also stops.
  it('stops a response body that sends no more data after the socket timeout', async () => {
    process.env.CLOUD_CACHE_SOCKET_TIMEOUT_MS = '6500';
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write(Buffer.alloc(100)); // then nothing
    };
    const { client } = createStorageContext({ maxAttempts: 1 });
    const output = await client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }));
    const start = Date.now();
    const error = await (async () => {
      for await (const _chunk of output.Body as AsyncIterable<Buffer>) {
        // read until the stream fails
      }
    })().then(
      () => undefined,
      (err: unknown) => err as Error & { code?: string }
    );
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(error?.name).toBe('TimeoutError');
    expect(error?.message).toBe('GetObject s3://b/k: no data from the server for 6.5 s');
    client.destroy();
  }, 30_000);

  it('stops a request on a silent connection after the socket timeout', async () => {
    process.env.CLOUD_CACHE_SOCKET_TIMEOUT_MS = '300';
    handler = () => undefined; // never answers
    const { client } = createStorageContext({ maxAttempts: 2 });
    const start = Date.now();
    const error = await client.send(head()).then(
      () => undefined,
      (err: unknown) => err as Error
    );
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(error?.name).toBe('TimeoutError');
    expect(error?.message).toMatch(/^HeadObject s3:\/\/b\/k failed after 2 attempts: /);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringMatching(/^HeadObject s3:\/\/b\/k: attempt 1 of 2 failed after /)
    );
    client.destroy();
  });
});
