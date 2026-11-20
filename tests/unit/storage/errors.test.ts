import {
  annotateS3Error,
  isAccessDeniedError,
  isWriteAccessDeniedError,
  s3ErrorMessage,
  s3OperationOf,
} from '../../../src/storage/errors';

// The SDK gives an S3 error the name of the error code and the HTTP status in $metadata.
const s3Error = (status: number, name: string): Error =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('isAccessDeniedError', () => {
  it('matches an AccessDenied error, with and without its 403 status', () => {
    expect(isAccessDeniedError(s3Error(403, 'AccessDenied'))).toBe(true);
    expect(isAccessDeniedError(Object.assign(new Error('x'), { name: 'AccessDenied' }))).toBe(true);
  });

  it('matches a 403 that has no error code in the body', () => {
    expect(isAccessDeniedError(s3Error(403, 'Forbidden'))).toBe(true);
  });

  it('matches an access-denied error that another error wraps as its cause', () => {
    const wrapped = new Error('upload failed', { cause: s3Error(403, 'AccessDenied') });
    expect(isAccessDeniedError(wrapped)).toBe(true);
  });

  it.each([
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'RequestTimeTooSkewed',
    'ExpiredToken',
    'InvalidToken',
    'TokenRefreshRequired',
  ])('does not match a 403 %s, because the credentials are wrong, not read-only', (name) => {
    expect(isAccessDeniedError(s3Error(403, name))).toBe(false);
    expect(isAccessDeniedError(new Error('upload failed', { cause: s3Error(403, name) }))).toBe(
      false
    );
  });

  it.each([
    s3Error(404, 'NoSuchKey'),
    s3Error(401, 'Unauthorized'),
    s3Error(503, 'SlowDown'),
    new Error('Access Denied'),
    'AccessDenied',
    undefined,
  ])('does not match %p', (err) => {
    expect(isAccessDeniedError(err)).toBe(false);
  });
});

// A HEAD response has no body, so the SDK names a 403 on HeadObject `Unknown` / `UnknownError`.
const headError = (status: number): Error =>
  Object.assign(new Error('UnknownError'), {
    name: 'Unknown',
    $metadata: { httpStatusCode: status, attempts: 1 },
  });

describe('s3ErrorMessage', () => {
  const head = { operation: 'HeadObject', bucket: 'b', key: 'k' };

  it('names the operation, the object and the HTTP status of a 403 with no body', () => {
    const message = s3ErrorMessage(headError(403), head);
    expect(message).toMatch(/^HeadObject s3:\/\/b\/k returned HTTP 403 Forbidden\. /);
    expect(message).not.toContain('UnknownError');
  });

  it('tells a reader of a 403 on HeadObject to check the credentials and s3:ListBucket', () => {
    expect(s3ErrorMessage(headError(403), head)).toContain(
      'Check access-key, secret-key and region, and check that the bucket policy allows s3:ListBucket on the bucket and s3:GetObject on the cache keys.'
    );
  });

  it.each([
    ['GetObject', 's3:GetObject on the cache keys'],
    ['ListObjectsV2', 's3:ListBucket on the bucket'],
    ['PutObject', 's3:PutObject on the cache keys'],
    ['UploadPart', 's3:PutObject on the cache keys'],
    ['CreateMultipartUpload', 's3:PutObject on the cache keys'],
    ['DeleteObject', 's3:DeleteObject on the cache keys'],
  ])('names the permission that %s needs', (operation, permission) => {
    expect(s3ErrorMessage(s3Error(403, 'AccessDenied'), { operation, bucket: 'b' })).toContain(
      `the bucket policy allows ${permission}.`
    );
  });

  it('keeps the S3 message and code of a 403 that has a body', () => {
    const err = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    expect(s3ErrorMessage(err, { operation: 'PutObject', bucket: 'b', key: 'k' })).toMatch(
      /^PutObject s3:\/\/b\/k returned HTTP 403 Forbidden: Access Denied \(AccessDenied\)\. Check /
    );
  });

  it('names only the credentials for a credential error', () => {
    const message = s3ErrorMessage(s3Error(403, 'SignatureDoesNotMatch'), head);
    expect(message).toContain('Check access-key, secret-key, session-token and region.');
    expect(message).not.toContain('bucket policy');
  });

  it('names the bucket alone when the request has no key', () => {
    expect(s3ErrorMessage(headError(403), { operation: 'ListObjectsV2', bucket: 'b' })).toMatch(
      /^ListObjectsV2 s3:\/\/b returned HTTP 403/
    );
  });

  it('replaces UnknownError for other statuses too, with the attempt count', () => {
    const err = Object.assign(new Error('UnknownError'), {
      name: 'Unknown',
      $metadata: { httpStatusCode: 503, attempts: 4 },
    });
    expect(s3ErrorMessage(err, head)).toBe(
      'HeadObject s3://b/k returned HTTP 503 Service Unavailable after 4 attempts'
    );
  });

  it('names a 301 and points to the bucket region', () => {
    const message = s3ErrorMessage(headError(301), head);
    expect(message).toMatch(/^HeadObject s3:\/\/b\/k returned HTTP 301 Moved Permanently\. /);
    expect(message).toContain('x-amz-bucket-region');
    expect(message).toContain('region');
  });

  it('adds the operation and the attempt count to a network error after retries', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT 10.255.255.1:9000'), {
      code: 'ETIMEDOUT',
      $metadata: { attempts: 4 },
    });
    expect(s3ErrorMessage(err, head)).toBe(
      'HeadObject s3://b/k failed after 4 attempts: connect ETIMEDOUT 10.255.255.1:9000'
    );
  });

  it.each([
    [s3Error(404, 'NotFound'), 'NotFound'],
    [s3Error(503, 'SlowDown'), 'SlowDown'],
    [Object.assign(new Error('socket hang up'), { $metadata: { attempts: 1 } }), 'socket hang up'],
    [new Error('plain'), 'plain'],
  ])('keeps a useful message that is not a 403: %p', (err, message) => {
    expect(s3ErrorMessage(err, head)).toBe(message);
  });
});

describe('annotateS3Error and isWriteAccessDeniedError', () => {
  it('rewrites the message and records the operation', () => {
    const err = headError(403);
    annotateS3Error(err, { operation: 'HeadObject', bucket: 'b', key: 'k' });
    expect(err.message).toMatch(/^HeadObject s3:\/\/b\/k returned HTTP 403 Forbidden\./);
    expect(s3OperationOf(err)).toBe('HeadObject');
    expect(s3OperationOf(new Error('wrapped', { cause: err }))).toBe('HeadObject');
  });

  it('annotates an error only once', () => {
    const err = headError(403);
    annotateS3Error(err, { operation: 'HeadObject', bucket: 'b', key: 'k' });
    const first = err.message;
    annotateS3Error(err, { operation: 'HeadObject', bucket: 'b', key: 'k' });
    expect(err.message).toBe(first);
  });

  it.each([
    'PutObject',
    'CreateMultipartUpload',
    'UploadPart',
    'CompleteMultipartUpload',
    'CopyObject',
  ])('matches an access denial from the write call %s', (operation) => {
    const err = s3Error(403, 'AccessDenied');
    annotateS3Error(err, { operation, bucket: 'b', key: 'k' });
    expect(isWriteAccessDeniedError(err)).toBe(true);
    expect(isWriteAccessDeniedError(new Error('upload failed', { cause: err }))).toBe(true);
  });

  it.each(['HeadObject', 'GetObject', 'ListObjectsV2'])(
    'does not match a 403 from the read call %s',
    (operation) => {
      const err = headError(403);
      annotateS3Error(err, { operation, bucket: 'b', key: 'k' });
      expect(isWriteAccessDeniedError(err)).toBe(false);
    }
  );

  it('does not match a 403 whose operation is not known', () => {
    expect(isWriteAccessDeniedError(s3Error(403, 'AccessDenied'))).toBe(false);
  });

  it('does not match a credential error from a write call', () => {
    const err = s3Error(403, 'SignatureDoesNotMatch');
    annotateS3Error(err, { operation: 'PutObject', bucket: 'b', key: 'k' });
    expect(isWriteAccessDeniedError(err)).toBe(false);
  });
});
