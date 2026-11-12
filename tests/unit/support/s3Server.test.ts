import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getTestS3Config, prepareTestBucket } from '../../support/s3Server';

describe('test S3 server config', () => {
  it('defaults to the local SeaweedFS with the CI identity', () => {
    expect(getTestS3Config({})).toEqual({
      endpoint: 'http://127.0.0.1:8333',
      region: 'us-east-1',
      accessKeyId: 'cloudcacheci',
      secretAccessKey: 'cloudcachecisecret',
      provider: 'seaweedfs',
      bucket: 'cloud-cache-test',
      required: false,
    });
  });

  it('reads overrides from TEST_S3_* and REQUIRE_S3', () => {
    expect(
      getTestS3Config({
        TEST_S3_ENDPOINT: 'http://127.0.0.1:3900',
        TEST_S3_REGION: 'garage',
        TEST_S3_ACCESS_KEY: 'GK0123456789abcdef01234567',
        TEST_S3_SECRET_KEY: 'secret',
        TEST_S3_PROVIDER: 'garage',
        TEST_S3_BUCKET: 'other',
        REQUIRE_S3: '1',
      })
    ).toEqual({
      endpoint: 'http://127.0.0.1:3900',
      region: 'garage',
      accessKeyId: 'GK0123456789abcdef01234567',
      secretAccessKey: 'secret',
      provider: 'garage',
      bucket: 'other',
      required: true,
    });
  });

  describe('AWS Emulator keys', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3server-'));
      file = path.join(dir, 'emulator_credentials');
      fs.writeFileSync(
        file,
        [
          '[other]',
          'aws_access_key_id = OTHERKEY',
          'aws_secret_access_key = OTHERSECRET',
          '[default]',
          'aws_access_key_id = EMULATOR0123456789AB',
          'aws_secret_access_key = 0123456789ABCDEF0123456789ABCDEF01234567',
          '',
        ].join('\n')
      );
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('reads the default profile from the shared credentials file', () => {
      const config = getTestS3Config({
        TEST_S3_PROVIDER: 'aws-emulator',
        AWS_SHARED_CREDENTIALS_FILE: file,
      });
      expect(config.accessKeyId).toBe('EMULATOR0123456789AB');
      expect(config.secretAccessKey).toBe('0123456789ABCDEF0123456789ABCDEF01234567');
    });

    it('prefers TEST_S3_ACCESS_KEY over the file', () => {
      const config = getTestS3Config({
        TEST_S3_PROVIDER: 'aws-emulator',
        TEST_S3_ACCESS_KEY: 'explicit',
        TEST_S3_SECRET_KEY: 'explicit-secret',
        AWS_SHARED_CREDENTIALS_FILE: file,
      });
      expect(config.accessKeyId).toBe('explicit');
    });

    it('ignores the file for any other provider', () => {
      const config = getTestS3Config({ AWS_SHARED_CREDENTIALS_FILE: file });
      expect(config.accessKeyId).toBe('cloudcacheci');
    });
  });

  it('reports an unreachable server as unavailable when S3 is optional', async () => {
    const config = { ...getTestS3Config({}), endpoint: 'http://127.0.0.1:1' };
    await expect(prepareTestBucket(config)).resolves.toBe(false);
  });

  it('fails on an unreachable server when REQUIRE_S3=1', async () => {
    const config = { ...getTestS3Config({}), endpoint: 'http://127.0.0.1:1', required: true };
    await expect(prepareTestBucket(config)).rejects.toThrow('REQUIRE_S3=1');
  });
});
