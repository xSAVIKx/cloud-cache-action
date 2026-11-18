import { describe, expect, it } from '@jest/globals';
import { usage } from '../../../src/cli/args';
import { editDistance, nearestFlag } from '../../../src/cli/flagHint';
import { COMMAND_SUMMARIES, commandUsage, inputFlagText } from '../../../src/cli/help';

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

  it('keeps each line at 100 characters or fewer', () => {
    for (const command of ['restore', 'save', 'inspect', 'prune'] as const) {
      for (const line of commandUsage(command).split('\n')) {
        expect([line, line.length <= 100]).toEqual([line, true]);
      }
    }
    // The key pattern default is too long for the column, so it has a line of its own.
    expect(commandUsage('restore')).toContain(
      '\n    ${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}.\n'
    );
  });

  it('marks the GitHub-only flags and tells what other flags do on the CLI', () => {
    const flat = commandUsage('restore').replace(/\s+/g, ' ');
    for (const name of ['use-fallback', 'dual-cache', 'restore-priority']) {
      expect(inputFlagText('restore', name)).toContain('GitHub Actions only');
    }
    expect(flat).toContain('On the CLI: no effect on the generic platform.');
    expect(flat).toContain('On the CLI: exit with code 1 when no key matches.');
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
