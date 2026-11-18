export type StorageProvider =
  | 'aws'
  | 'r2'
  | 'gcs'
  | 'b2'
  | 'fastly'
  | 'garage'
  | 'seaweedfs'
  | 'minio'
  | 'rustfs'
  | 'aws-emulator'
  | 'generic-s3';

export interface ProviderConfig {
  provider: StorageProvider;
  endpoint?: string;
  region: string;
  forcePathStyle: boolean;
  /** The largest request body the server accepts, so the largest upload part. Unset: no limit. */
  maxPartSize?: number;
}

/** The AWS Emulator answers HTTP 413 to a PutObject or UploadPart body above 16 MiB (1.0.322). */
const AWS_EMULATOR_MAX_PART_SIZE = 16 * 1024 * 1024;

export const KNOWN_PROVIDERS = [
  'aws',
  's3',
  'r2',
  'cloudflare',
  'gcs',
  'google',
  'b2',
  'backblaze',
  'fastly',
  'garage',
  'seaweedfs',
  'seaweed',
  'minio',
  'rustfs',
  'aws-emulator',
] as const;

export function isKnownProvider(name: string): boolean {
  return (KNOWN_PROVIDERS as readonly string[]).includes(name.toLowerCase().trim());
}

export function detectProvider(endpointInput?: string, explicitProvider?: string): StorageProvider {
  if (explicitProvider) {
    const normalized = explicitProvider.toLowerCase().trim();
    switch (normalized) {
      case 'aws':
      case 's3':
        return 'aws';
      case 'r2':
      case 'cloudflare':
        return 'r2';
      case 'gcs':
      case 'google':
        return 'gcs';
      case 'b2':
      case 'backblaze':
        return 'b2';
      case 'fastly':
        return 'fastly';
      case 'garage':
        return 'garage';
      case 'seaweedfs':
      case 'seaweed':
        return 'seaweedfs';
      case 'minio':
        return 'minio';
      case 'rustfs':
        return 'rustfs';
      case 'aws-emulator':
        return 'aws-emulator';
      default:
        return 'generic-s3';
    }
  }

  if (!endpointInput) {
    return 'aws';
  }

  const ep = endpointInput.toLowerCase();
  if (ep.includes('r2.cloudflarestorage.com')) {
    return 'r2';
  }
  if (ep.includes('storage.googleapis.com')) {
    return 'gcs';
  }
  if (ep.includes('backblazeb2.com')) {
    return 'b2';
  }
  if (ep.includes('fastlystorage.com')) {
    return 'fastly';
  }
  if (ep.includes('amazonaws.com')) {
    return 'aws';
  }
  if (ep.includes(':3900')) {
    return 'garage';
  }
  if (ep.includes(':8333')) {
    return 'seaweedfs';
  }
  // The AWS Emulator serves every AWS API, S3 included, on https://127.0.0.1:9297 by default.
  if (ep.includes(':9297')) {
    return 'aws-emulator';
  }
  // RustFS serves S3 on the same default port as MinIO, so the port alone cannot tell them
  // apart; both take the same defaults here. Set `provider: rustfs` to name it in the log.
  if (ep.includes(':9000')) {
    return 'minio';
  }

  return 'generic-s3';
}

export function resolveProviderDefaults(
  endpointInput?: string,
  regionInput?: string,
  forcePathStyleInput?: boolean,
  explicitProvider?: string
): ProviderConfig {
  const provider = detectProvider(endpointInput, explicitProvider);

  let endpoint = endpointInput?.trim();
  if (endpoint && !endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    endpoint = `https://${endpoint}`;
  }

  let region = regionInput?.trim();
  let forcePathStyle = forcePathStyleInput;

  switch (provider) {
    case 'aws':
      region = region || process.env.AWS_REGION || 'us-east-1';
      if (forcePathStyle === undefined) forcePathStyle = false;
      break;

    case 'r2':
      region = region || 'auto';
      if (forcePathStyle === undefined) forcePathStyle = false;
      break;

    case 'gcs':
      endpoint = endpoint || 'https://storage.googleapis.com';
      region = region || 'auto';
      if (forcePathStyle === undefined) forcePathStyle = true;
      break;

    case 'b2':
      if (!region && endpoint) {
        // e.g. https://s3.us-west-004.backblazeb2.com
        const match = endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/i);
        if (match && match[1]) {
          region = match[1];
        }
      }
      region = region || 'us-east-1';
      if (forcePathStyle === undefined) forcePathStyle = false;
      break;

    case 'fastly':
      region = region || 'us-east-1';
      if (forcePathStyle === undefined) forcePathStyle = true;
      break;

    case 'garage':
      region = region || 'garage';
      if (forcePathStyle === undefined) forcePathStyle = true;
      break;

    case 'seaweedfs':
      region = region || 'auto';
      if (forcePathStyle === undefined) forcePathStyle = true;
      break;

    case 'aws-emulator':
      // The emulator accepts any region but keeps no separate state per region, and it rejects a
      // bucket name in the host name, so path-style addressing is required.
      region = region || 'us-east-1';
      if (forcePathStyle === undefined) forcePathStyle = true;
      break;

    case 'minio':
    case 'rustfs':
    case 'generic-s3':
    default:
      region = region || 'us-east-1';
      if (forcePathStyle === undefined) forcePathStyle = true;
      break;
  }

  return {
    provider,
    endpoint,
    region,
    forcePathStyle: Boolean(forcePathStyle),
    ...(provider === 'aws-emulator' ? { maxPartSize: AWS_EMULATOR_MAX_PART_SIZE } : {}),
  };
}
