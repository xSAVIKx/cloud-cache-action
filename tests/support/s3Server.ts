import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Where the integration suite and CI helpers find their S3 server. */
export interface TestS3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  provider: string;
  bucket: string;
  required: boolean;
}

/**
 * Reads the default profile keys from an AWS shared credentials file. The AWS Emulator writes new
 * keys to such a file at each start, so CI cannot put fixed keys in the workflow.
 */
export function readSharedCredentials(
  file: string
): { accessKeyId: string; secretAccessKey: string } | undefined {
  let profile = '';
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      profile = section[1].trim();
      continue;
    }
    const pair = line.match(/^\s*([a-z_]+)\s*=\s*(\S+)/);
    if (pair && profile === 'default') {
      values[pair[1]] = pair[2];
    }
  }
  const { aws_access_key_id: accessKeyId, aws_secret_access_key: secretAccessKey } = values;
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
}

export function getTestS3Config(env: NodeJS.ProcessEnv = process.env): TestS3Config {
  const provider = env.TEST_S3_PROVIDER || 'seaweedfs';
  const emulatorKeys =
    provider === 'aws-emulator' && !env.TEST_S3_ACCESS_KEY && env.AWS_SHARED_CREDENTIALS_FILE
      ? readSharedCredentials(env.AWS_SHARED_CREDENTIALS_FILE)
      : undefined;
  return {
    endpoint: env.TEST_S3_ENDPOINT || 'http://127.0.0.1:8333',
    region: env.TEST_S3_REGION || 'us-east-1',
    accessKeyId: env.TEST_S3_ACCESS_KEY || emulatorKeys?.accessKeyId || 'cloudcacheci',
    secretAccessKey:
      env.TEST_S3_SECRET_KEY || emulatorKeys?.secretAccessKey || 'cloudcachecisecret',
    provider,
    bucket: env.TEST_S3_BUCKET || 'cloud-cache-test',
    required: env.REQUIRE_S3 === '1',
  };
}

export function createTestS3Client(config: TestS3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

/**
 * Creates the test bucket. Resolves false when the server is unusable and S3 is optional,
 * so local runs without a server skip; rejects when REQUIRE_S3=1, so CI cannot skip silently.
 */
export async function prepareTestBucket(config: TestS3Config): Promise<boolean> {
  const client = createTestS3Client(config);
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    return true;
  } catch (err: unknown) {
    const { name = '', message = String(err) } = err as { name?: string; message?: string };
    if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
      return true;
    }
    if (config.required) {
      throw new Error(
        `REQUIRE_S3=1 but the S3 server at ${config.endpoint} is not usable: ${name} ${message}`,
        { cause: err }
      );
    }
    return false;
  } finally {
    client.destroy();
  }
}

/**
 * Deletes every object under a prefix. A suite calls this in afterAll, so the bucket does not grow
 * with each run. The AWS Emulator keeps at most 64 MiB of objects in one bucket.
 */
export async function deleteTestPrefix(config: TestS3Config, prefix: string): Promise<void> {
  const client = createTestS3Client(config);
  try {
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        })
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: keys, Quiet: true },
          })
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = { ...getTestS3Config(), required: true };
  await prepareTestBucket(config);
  console.log(`Bucket ${config.bucket} is ready at ${config.endpoint}`);
}
