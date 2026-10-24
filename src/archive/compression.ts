import * as io from '@actions/io';
import { log } from '../ci/log';

export type CompressionMethod = 'zstd' | 'gzip';

export interface CompressionConfig {
  method: CompressionMethod;
  archiveFilename: string;
}

let cachedConfig: CompressionConfig | null = null;

export async function getCompressionConfig(): Promise<CompressionConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    const zstdPath = await io.which('zstd', false);
    if (zstdPath) {
      log.debug(`zstd binary found at: ${zstdPath}`);
      cachedConfig = {
        method: 'zstd',
        archiveFilename: 'cache.tar.zst',
      };
      return cachedConfig;
    }
  } catch (err) {
    log.debug(`zstd detection error: ${err}`);
  }

  log.debug('zstd binary not found; falling back to gzip');
  cachedConfig = {
    method: 'gzip',
    archiveFilename: 'cache.tar.gz',
  };
  return cachedConfig;
}

export function resetCompressionConfigCache(): void {
  cachedConfig = null;
}
