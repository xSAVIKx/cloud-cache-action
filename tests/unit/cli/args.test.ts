import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { parseCliArgs, UsageError } from '../../../src/cli/args';

function parse(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const result = parseCliArgs(argv, env);
  if (!('command' in result)) {
    throw new Error('expected a command');
  }
  return result;
}

describe('parseCliArgs', () => {
  it('parses repeatable path flags', () => {
    const result = parse([
      'restore',
      '--key',
      'deps-1',
      '--path',
      'node_modules',
      '--path=.cache',
      '--restore-keys',
      'deps-',
    ]);
    expect(result.command).toBe('restore');
    expect(result.inputs).toEqual({
      key: 'deps-1',
      path: 'node_modules\n.cache',
      'restore-keys': 'deps-',
    });
  });

  it('boolean flag forms', () => {
    expect(parse(['restore', '--lookup-only']).inputs['lookup-only']).toBe('true');
    expect(parse(['restore', '--lookup-only=true']).inputs['lookup-only']).toBe('true');
    expect(parse(['restore', '--lookup-only=false']).inputs['lookup-only']).toBe('false');
    expect(parse(['prune', '--dry-run']).inputs['dry-run']).toBe('true');
    // A bare boolean flag does not take the next word as its value.
    expect(() => parse(['restore', '--retry', 'false'])).toThrow(UsageError);
    expect(() => parse(['restore', '--retry=yes'])).toThrow(/--retry/);
    expect(parse(['save', '--debug']).debug).toBe(true);
    expect(parse(['save', '--debug=false'], { CLOUD_CACHE_DEBUG: 'true' }).debug).toBe(false);
  });

  it('env fills a missing flag', () => {
    const fromEnv = parse(['save'], {
      CLOUD_CACHE_STATE_FILE: '/tmp/s.json',
      CLOUD_CACHE_OUTPUTS_FILE: '/tmp/o.txt',
      CLOUD_CACHE_DEBUG: 'true',
      CLOUD_CACHE_KEY: 'from-env',
    });
    expect(fromEnv.stateFile).toBe('/tmp/s.json');
    expect(fromEnv.outputsFile).toBe('/tmp/o.txt');
    expect(fromEnv.debug).toBe(true);
    // Input env vars stay out of the inputs: the host reads them, so a flag wins over env.
    expect(fromEnv.inputs).toEqual({});

    const fromFlag = parse(['save', '--state-file', '/x/state.json'], {
      CLOUD_CACHE_STATE_FILE: '/tmp/s.json',
    });
    expect(fromFlag.stateFile).toBe('/x/state.json');

    const defaults = parse(['save']);
    expect(defaults.stateFile).toBe(join(tmpdir(), 'cloud-cache-state.json'));
    expect(defaults.outputsFile).toBeUndefined();
    expect(defaults.debug).toBe(false);
  });

  it('unknown flag is a usage error', () => {
    expect(() => parse(['restore', '--nope', 'x'])).toThrow(UsageError);
    expect(() => parse(['restore', '--nope', 'x'])).toThrow('unknown flag --nope');
    // max-candidates belongs to inspect only.
    expect(() => parse(['restore', '--max-candidates', '5'])).toThrow(
      '--max-candidates is not a flag of the restore command'
    );
    expect(parse(['inspect', '--max-candidates', '5']).inputs['max-candidates']).toBe('5');
    expect(() => parse(['fetch'])).toThrow('unknown command fetch');
    expect(() => parse([])).toThrow(UsageError);
    expect(() => parse(['restore', 'extra'])).toThrow(UsageError);
    expect(() => parse(['restore', '--key'])).toThrow('--key needs a value');
    expect(() => parse(['restore', '--key', 'a', '--key', 'b'])).toThrow(UsageError);
  });

  it('help and version', () => {
    expect(parseCliArgs(['--help'], {})).toEqual({ help: true });
    expect(parseCliArgs(['-h'], {})).toEqual({ help: true });
    expect(parseCliArgs(['restore', '--help'], {})).toEqual({ help: true });
    expect(parseCliArgs(['--version'], {})).toEqual({ version: true });
  });

  it('parses the platform flags and their env vars', () => {
    const base = parse(['restore']);
    expect(base.platform).toBe('auto');
    expect(base.allowRefOverride).toBe(false);
    expect(base.roleArn).toBeUndefined();
    expect(base.saveOnFailure).toBe(false);

    const flags = parse([
      'save',
      '--platform',
      'bitbucket',
      '--allow-ref-override',
      '--role-arn=arn:aws:iam::1:role/x',
      '--save-on-failure',
    ]);
    expect(flags.platform).toBe('bitbucket');
    expect(flags.allowRefOverride).toBe(true);
    expect(flags.roleArn).toBe('arn:aws:iam::1:role/x');
    expect(flags.saveOnFailure).toBe(true);
    expect(parse(['prune', '--allow-ref-override=false']).allowRefOverride).toBe(false);
    expect(flags.inputs).toEqual({});

    const fromEnv = parse(['save'], {
      CLOUD_CACHE_PLATFORM: 'generic',
      CLOUD_CACHE_ALLOW_REF_OVERRIDE: 'true',
      CLOUD_CACHE_ROLE_ARN: 'arn:env',
      CLOUD_CACHE_SAVE_ON_FAILURE: '1',
    });
    expect(fromEnv.platform).toBe('generic');
    expect(fromEnv.allowRefOverride).toBe(true);
    expect(fromEnv.roleArn).toBe('arn:env');
    expect(fromEnv.saveOnFailure).toBe(true);
    expect(
      parse(['save', '--platform', 'bitbucket'], { CLOUD_CACHE_PLATFORM: 'generic' }).platform
    ).toBe('bitbucket');
  });

  it('rejects an unknown platform', () => {
    expect(() => parse(['restore', '--platform', 'foo'])).toThrow(/auto, generic, bitbucket/);
    expect(() => parse(['restore'], { CLOUD_CACHE_PLATFORM: 'foo' })).toThrow(UsageError);
  });

  it('accepts --save-on-failure only for save', () => {
    for (const command of ['restore', 'inspect', 'prune']) {
      expect(() => parse([command, '--save-on-failure'])).toThrow(UsageError);
    }
    for (const command of ['restore', 'save', 'inspect', 'prune']) {
      expect(
        parse([command, '--platform', 'generic', '--allow-ref-override', '--role-arn', 'a'])
          .platform
      ).toBe('generic');
    }
  });
});
