import { describe, expect, it } from '@jest/globals';
import { usage } from '../../../src/cli/args';
import { toCliWords } from '../../../src/cli/cliWords';
import { editDistance, nearestFlag } from '../../../src/cli/flagHint';
import { COMMAND_SUMMARIES, commandUsage } from '../../../src/cli/help';

describe('commandUsage', () => {
  it('prints the purpose, the groups and the CLI flags of restore', () => {
    const text = commandUsage('restore');
    expect(text.startsWith('Usage: cloud-cache restore [flags]\n')).toBe(true);
    expect(text).toContain(COMMAND_SUMMARIES.restore);
    for (const title of [
      'Required (set --key and --path, or set --preset):',
      'Storage:',
      'Cache:',
      'Transfer:',
      'Advanced:',
      'CLI:',
    ]) {
      expect(text).toContain(`\n${title}\n`);
    }
    expect(text).toMatch(/--bucket <value> +The S3 bucket name where cache archives are stored\./);
    // The help wraps long descriptions, so compare the text with one space for each break.
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('Env: CLOUD_CACHE_BUCKET, then AWS_S3_BUCKET or S3_BUCKET.');
    expect(flat).toContain('Default: 3. Env: CLOUD_CACHE_RETRY_COUNT.');
    expect(text).not.toContain('--save-on-failure');
    expect(text).not.toContain('--max-candidates');
  });

  it('shows --save-on-failure only for save', () => {
    expect(commandUsage('save')).toContain('--save-on-failure[=true|false]');
  });

  it('prune has only the bucket as a required flag, and --ref reads no env var', () => {
    const text = commandUsage('prune');
    expect(text).toContain('\nRequired:\n  --bucket <value>');
    expect(text).toMatch(/--ref <value> +Prune only caches[^]*?Env: none\./);
    expect(text).toContain('Exit codes: 0 success, 1 failure, 2 usage error.');
  });

  it('keeps each line at 100 characters or fewer, except an unbreakable word', () => {
    for (const command of ['restore', 'save', 'inspect', 'prune'] as const) {
      for (const line of commandUsage(command).split('\n')) {
        if (line.length > 100) {
          expect(line.trim()).not.toContain(' ');
        }
      }
    }
  });

  it('the full help lists the same command purposes', () => {
    for (const summary of Object.values(COMMAND_SUMMARIES)) {
      expect(usage()).toContain(summary);
    }
  });
});

describe('nearestFlag', () => {
  it('finds a flag at an edit distance of 2 or less', () => {
    expect(editDistance('buket', 'bucket')).toBe(1);
    expect(nearestFlag('buket', ['key', 'bucket'])).toBe('bucket');
    expect(nearestFlag('restore-key', ['restore-keys', 'key'])).toBe('restore-keys');
    expect(nearestFlag('enablecrossosarchive', ['enableCrossOsArchive'])).toBe(
      'enableCrossOsArchive'
    );
    expect(nearestFlag('nope', ['bucket', 'key', 'path'])).toBeUndefined();
  });
});

describe('toCliWords', () => {
  it.each([
    [
      'Bucket name is required. Please set "bucket" input or AWS_S3_BUCKET environment variable.',
      'The bucket name is required. Set --bucket, CLOUD_CACHE_BUCKET, AWS_S3_BUCKET or S3_BUCKET.',
    ],
    [
      'Input required and not supplied: path. Set key and path, or set preset.',
      'The flag --path is required and not set. Set --key and --path, or set --preset.',
    ],
    ['Input required and not supplied: key', 'The flag --key is required and not set'],
    [
      'Key is not specified. Set key and path, or set preset. Skipping cache save.',
      'Key is not specified. Set --key and --path, or set --preset, or run restore with the same ' +
        '--state-file first. Skipping cache save.',
    ],
    [
      'Access denied. The credentials may not be allowed to write to the bucket. Set read-only: true to skip the save.',
      'Access denied. The credentials may not be allowed to write to the bucket. Set --read-only to skip the save.',
    ],
    [
      'Input "upload-chunk-size" must be an integer between 5242880 and 134217728; got "1". Using 67108864.',
      '--upload-chunk-size must be an integer between 5242880 and 134217728; got "1". Using 67108864.',
    ],
    [
      'The "ref" input "main" is not a full Git ref.',
      'The --ref value "main" is not a full Git ref.',
    ],
    [
      'Invalid "metadata" line "x": expected key=value.',
      'Invalid --metadata line "x": expected key=value.',
    ],
    ['"tags" allows at most 10 tags; got 11.', '--tags allows at most 10 tags; got 11.'],
    ['The key "tags" is not set.', 'The key "tags" is not set.'],
  ])('%s', (input, output) => {
    expect(toCliWords(input)).toBe(output);
  });

  it('leaves other messages as they are', () => {
    const text = 'Cache restored from key: linux-npm-abc';
    expect(toCliWords(text)).toBe(text);
  });
});
