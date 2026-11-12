import {
  detectProvider,
  isKnownProvider,
  resolveProviderDefaults,
} from '../../src/storage/providers';

describe('Storage Providers', () => {
  describe('detectProvider', () => {
    it('detects AWS when no endpoint is provided', () => {
      expect(detectProvider()).toBe('aws');
    });

    it('detects AWS when endpoint contains amazonaws.com', () => {
      expect(detectProvider('https://s3.us-east-1.amazonaws.com')).toBe('aws');
    });

    it('detects Cloudflare R2 from endpoint URL', () => {
      expect(detectProvider('https://abc123def456.r2.cloudflarestorage.com')).toBe('r2');
    });

    it('detects Google Cloud Storage from endpoint URL', () => {
      expect(detectProvider('https://storage.googleapis.com')).toBe('gcs');
    });

    it('detects Backblaze B2 from endpoint URL', () => {
      expect(detectProvider('https://s3.us-west-004.backblazeb2.com')).toBe('b2');
    });

    it('detects Fastly Object Storage from endpoint URL', () => {
      expect(detectProvider('https://object.us-east-1.fastlystorage.com')).toBe('fastly');
    });

    it('detects Garage from standard port :3900', () => {
      expect(detectProvider('http://127.0.0.1:3900')).toBe('garage');
    });

    it('detects SeaweedFS from standard port :8333', () => {
      expect(detectProvider('http://127.0.0.1:8333')).toBe('seaweedfs');
    });

    it('detects MinIO from standard port :9000', () => {
      expect(detectProvider('http://localhost:9000')).toBe('minio');
    });

    it('respects explicit provider parameter over endpoint heuristic', () => {
      expect(detectProvider('http://custom-url:1234', 'r2')).toBe('r2');
      expect(detectProvider('http://custom-url:1234', 'gcs')).toBe('gcs');
      expect(detectProvider('http://custom-url:1234', 'b2')).toBe('b2');
      expect(detectProvider('http://custom-url:1234', 'garage')).toBe('garage');
      expect(detectProvider('http://custom-url:1234', 'seaweedfs')).toBe('seaweedfs');
    });
  });

  describe('resolveProviderDefaults', () => {
    it('configures Cloudflare R2 with region auto and virtual-hosted style', () => {
      const config = resolveProviderDefaults('https://myaccount.r2.cloudflarestorage.com');
      expect(config.provider).toBe('r2');
      expect(config.region).toBe('auto');
      expect(config.forcePathStyle).toBe(false);
    });

    it('configures Google Cloud Storage with path style', () => {
      const config = resolveProviderDefaults('https://storage.googleapis.com');
      expect(config.provider).toBe('gcs');
      expect(config.forcePathStyle).toBe(true);
    });

    it('extracts region automatically from Backblaze B2 endpoint', () => {
      const config = resolveProviderDefaults('https://s3.us-west-004.backblazeb2.com');
      expect(config.provider).toBe('b2');
      expect(config.region).toBe('us-west-004');
      expect(config.forcePathStyle).toBe(false);
    });

    it('configures Garage with path-style true', () => {
      const config = resolveProviderDefaults('http://localhost:3900');
      expect(config.provider).toBe('garage');
      expect(config.region).toBe('garage');
      expect(config.forcePathStyle).toBe(true);
    });

    it('configures SeaweedFS with path-style true', () => {
      const config = resolveProviderDefaults('http://localhost:8333');
      expect(config.provider).toBe('seaweedfs');
      expect(config.forcePathStyle).toBe(true);
    });

    it('allows overriding forcePathStyle and region explicitly', () => {
      const config = resolveProviderDefaults(
        'https://s3.us-west-004.backblazeb2.com',
        'custom-region',
        true
      );
      expect(config.region).toBe('custom-region');
      expect(config.forcePathStyle).toBe(true);
    });

    it('handles explicit provider aliases and generic-s3 fallback', () => {
      expect(detectProvider(undefined, 's3')).toBe('aws');
      expect(detectProvider(undefined, 'fastly')).toBe('fastly');
      expect(detectProvider(undefined, 'minio')).toBe('minio');
      expect(detectProvider(undefined, 'rustfs')).toBe('rustfs');
      expect(detectProvider(undefined, 'AWS-Emulator')).toBe('aws-emulator');
      expect(detectProvider(undefined, 'unknown-provider')).toBe('generic-s3');
      expect(detectProvider('https://unrecognized-s3.example.com')).toBe('generic-s3');
    });

    it('prepends https:// when protocol is omitted from endpoint', () => {
      const config = resolveProviderDefaults('custom-endpoint.domain.com');
      expect(config.endpoint).toBe('https://custom-endpoint.domain.com');
    });

    it('resolves defaults for fastly and minio providers', () => {
      const fastly = resolveProviderDefaults('https://object.us-east-1.fastlystorage.com');
      expect(fastly.provider).toBe('fastly');
      expect(fastly.forcePathStyle).toBe(true);
      expect(fastly.region).toBe('us-east-1');

      const minio = resolveProviderDefaults('http://localhost:9000');
      expect(minio.provider).toBe('minio');
      expect(minio.forcePathStyle).toBe(true);
      expect(minio.region).toBe('us-east-1');

      // RustFS serves S3 on MinIO's default port, so only an explicit provider names it.
      const rustfs = resolveProviderDefaults(
        'http://localhost:9000',
        undefined,
        undefined,
        'rustfs'
      );
      expect(rustfs.provider).toBe('rustfs');
      expect(rustfs.forcePathStyle).toBe(true);
      expect(rustfs.region).toBe('us-east-1');
    });

    it('detects the AWS Emulator from its default port and forces path-style addressing', () => {
      const emulator = resolveProviderDefaults('https://127.0.0.1:9297');
      expect(emulator).toEqual({
        provider: 'aws-emulator',
        endpoint: 'https://127.0.0.1:9297',
        region: 'us-east-1',
        forcePathStyle: true,
        maxPartSize: 16 * 1024 * 1024,
      });
    });

    it('sets no part size limit for other providers', () => {
      expect(resolveProviderDefaults('http://127.0.0.1:9000').maxPartSize).toBeUndefined();
    });

    it('keeps an explicit region and path-style choice for the AWS Emulator', () => {
      const emulator = resolveProviderDefaults(
        'https://127.0.0.1:9300',
        'eu-west-1',
        false,
        'aws-emulator'
      );
      expect(emulator.provider).toBe('aws-emulator');
      expect(emulator.region).toBe('eu-west-1');
      expect(emulator.forcePathStyle).toBe(false);
    });
  });

  describe('isKnownProvider', () => {
    it.each([
      'aws',
      'S3',
      ' r2 ',
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
    ])('knows %s', (name) => {
      expect(isKnownProvider(name)).toBe(true);
    });

    it.each(['cloudflare-r2', 'ceph', ''])('does not know "%s"', (name) => {
      expect(isKnownProvider(name)).toBe(false);
    });
  });
});
