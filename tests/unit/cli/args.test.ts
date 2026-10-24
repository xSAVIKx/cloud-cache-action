import { describe, expect, it } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
