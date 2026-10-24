import { afterEach, beforeAll, afterAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../../../src/constants';
import { GenericHost, type GenericHostOptions } from '../../../src/ci/generic';
import { FileStateProvider } from '../../../src/ci/stateFile';
import { formatOutput } from '../../../src/ci/outputsFile';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'generic-host-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  process.exitCode = undefined;
  jest.restoreAllMocks();
});

function host(options: Partial<GenericHostOptions> = {}, env: NodeJS.ProcessEnv = {}) {
  return new GenericHost({
    inputs: {},
    defaults: {},
    env,
    stateFile: join(dir, 'state.json'),
    ...options,
  });
}

describe('GenericHost', () => {
  it('context maps CLOUD_CACHE env', () => {
    const ctx = host(
      {},
      {
        CLOUD_CACHE_REPOSITORY: 'acme/app',
        CLOUD_CACHE_REF: 'refs/heads/feature',
        CLOUD_CACHE_BASE_REF: 'main',
        CLOUD_CACHE_DEFAULT_BRANCH: 'develop',
        CLOUD_CACHE_EVENT_NAME: 'pull_request',
        CLOUD_CACHE_WORKSPACE: '/work',
        HOME: '/home/me',
        RUNNER_OS: 'macOS',
      }
    ).context();
    expect(ctx.platform).toBe('generic');
    expect(ctx.repository).toBe('acme/app');
    expect(ctx.refs).toEqual({
      current: 'refs/heads/feature',
      restore: ['refs/heads/feature', 'refs/heads/main', 'refs/heads/develop'],
    });
    expect(ctx.eventName).toBe('pull_request');
    expect(ctx.workspace).toBe('/work');
    expect(ctx.homeDir).toBe('/home/me');
    expect(ctx.runnerOs).toBe('macOS');
  });

  it('context uses defaults when env is empty', () => {
    jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const ctx = host().context();
    expect(ctx.repository).toBe('');
    expect(ctx.eventName).toBe('cli');
    expect(ctx.workspace).toBe(process.cwd());
    expect(ctx.refs).toEqual({ current: undefined, restore: [] });
  });

  it('bare branch and full ref give the same refs', () => {
    const expected = ['refs/heads/pr', 'refs/heads/main', 'refs/heads/develop'];
    for (const [ref, base, def] of [
      ['pr', 'main', 'develop'],
      ['refs/heads/pr', 'main', 'develop'],
      ['pr', 'refs/heads/main', 'develop'],
      ['pr', 'main', 'refs/heads/develop'],
      ['refs/heads/pr', 'refs/heads/main', 'refs/heads/develop'],
    ] as const) {
      const refs = host(
        {},
        {
          CLOUD_CACHE_REPOSITORY: 'acme/app',
          CLOUD_CACHE_REF: ref,
          CLOUD_CACHE_BASE_REF: base,
          CLOUD_CACHE_DEFAULT_BRANCH: def,
        }
      ).context().refs;
      expect(refs).toEqual({ current: 'refs/heads/pr', restore: expected });
    }
  });

  it('flag beats env beats default', () => {
    const env = { CLOUD_CACHE_RESTORE_KEYS: 'from-env', CLOUD_CACHE_PATH: 'env-path' };
    const h = host(
      {
        inputs: { 'restore-keys': 'from-flag' },
        defaults: { 'restore-keys': 'def', path: 'def-path', other: 'def-other' },
      },
      env
    );
    expect(h.input('restore-keys')).toBe('from-flag');
    expect(h.input('path')).toBe('env-path');
    expect(h.input('other')).toBe('def-other');
    expect(h.input('unknown')).toBe('');
  });

  it('reads env at each call', () => {
    const env: NodeJS.ProcessEnv = {};
    const h = host({}, env);
    expect(h.input('key')).toBe('');
    env.CLOUD_CACHE_KEY = 'late';
    expect(h.input('key')).toBe('late');
  });

  it('trims by default and keeps spaces when asked', () => {
    const h = host({ inputs: { key: '  a  ' } });
    expect(h.input('key')).toBe('a');
    expect(h.input('key', { trimWhitespace: false })).toBe('  a  ');
  });

  it('required input missing throws the core message', () => {
    expect(() => host().input('key', { required: true })).toThrow(
      'Input required and not supplied: key'
    );
  });

  it('setOutput appends to the outputs file', () => {
    const outputsFile = join(dir, 'out-1.txt');
    const info = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const h = host({ outputsFile });
    h.setOutput('cache-hit', 'true');
    h.setOutput('count', 3);
    h.setOutput('obj', { a: 1 });
    expect(readFileSync(outputsFile, 'utf8')).toBe('cache-hit=true\ncount=3\nobj={"a":1}\n');
    expect(info).toHaveBeenCalledWith('cache-hit=true\n');
  });

  it('setOutput writes an empty value for undefined and null', () => {
    const outputsFile = join(dir, 'out-2.txt');
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const h = host({ outputsFile });
    h.setOutput('a', undefined);
    h.setOutput('b', null);
    expect(readFileSync(outputsFile, 'utf8')).toBe('a=\nb=\n');
  });

  it('setOutput only prints without an outputs file', () => {
    const out = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    host().setOutput('a', 'b');
    expect(out).toHaveBeenCalledWith('a=b\n');
  });

  it('multi-line output uses the delimiter form', () => {
    const formatted = formatOutput('notes', 'one\ntwo');
    const match = /^notes<<(CLOUD_CACHE_EOF_[0-9a-f]+)\none\ntwo\n\1\n$/.exec(formatted);
    expect(match).not.toBeNull();
    expect(formatOutput('k', 'v')).toBe('k=v\n');
  });

  it('outputs file in a missing directory fails with a clear error', () => {
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const outputsFile = join(dir, 'missing', 'out.txt');
    expect(() => host({ outputsFile }).setOutput('a', 'b')).toThrow(
      `Cannot write the outputs file ${outputsFile}`
    );
  });

  it('setFailed sets exitCode 1', () => {
    const err = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    host().setFailed(new Error('boom'));
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledWith('error: boom\n');
  });

  it('logs with prefixes and streams', () => {
    const out = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const quiet = host();
    quiet.log.debug('hidden');
    quiet.log.info('i');
    quiet.log.warning('w');
    quiet.log.error('e');
    quiet.log.startGroup('G');
    quiet.log.endGroup();
    expect(out.mock.calls.map((c) => c[0])).toEqual(['i\n', '▶ G\n']);
    expect(err.mock.calls.map((c) => c[0])).toEqual(['warning: w\n', 'error: e\n']);

    const loud = host({ debug: true });
    loud.log.debug('shown');
    expect(out).toHaveBeenLastCalledWith('debug: shown\n');
  });

  it('summary is undefined', () => {
    expect(host().summary).toBeUndefined();
  });

  it('inputs named like a context variable read only their flag', () => {
    const env = {
      CLOUD_CACHE_REF: 'refs/heads/feature',
      CLOUD_CACHE_REPOSITORY: 'acme/app',
      CLOUD_CACHE_BASE_REF: 'main',
      CLOUD_CACHE_DEFAULT_BRANCH: 'develop',
      CLOUD_CACHE_WORKSPACE: '/work',
      CLOUD_CACHE_EVENT_NAME: 'push',
      CLOUD_CACHE_KEY: 'env-key',
    };
    const names = ['ref', 'repository', 'base-ref', 'default-branch', 'workspace', 'event-name'];
    const fromEnv = host({}, env);
    for (const name of names) {
      expect(fromEnv.input(name)).toBe('');
    }
    // Other inputs still read their env var.
    expect(fromEnv.input('key')).toBe('env-key');

    const flags = Object.fromEntries(names.map((name) => [name, `flag-${name}`]));
    const fromFlags = host({ inputs: flags, defaults: { ref: 'def' } }, env);
    for (const name of names) {
      expect(fromFlags.input(name)).toBe(`flag-${name}`);
    }
    expect(host({ defaults: { ref: 'def' } }, env).input('ref')).toBe('def');
  });

  it('an empty repository warns once', () => {
    const err = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const empty = host();
    empty.context();
    empty.context();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('warning: CLOUD_CACHE_REPOSITORY is empty');

    err.mockClear();
    host({}, { CLOUD_CACHE_REPOSITORY: 'acme/app' }).context();
    host({ inputs: { 'scoped-to-repository': 'false' } }).context();
    expect(err).not.toHaveBeenCalled();
  });
});

describe('FileStateProvider', () => {
  it('state survives a new provider instance', () => {
    const file = join(dir, 'nested', 'state.json');
    new FileStateProvider(file).setState(State.CacheMatchedKey, 'k1');
    const next = new FileStateProvider(file);
    expect(next.getState(State.CacheMatchedKey)).toBe('k1');
    expect(next.getCacheState()).toBe('k1');
  });

  it('a second provider instance keeps the first key', () => {
    const file = join(dir, 'two.json');
    new FileStateProvider(file).setState('a', '1');
    new FileStateProvider(file).setState('b', '2');
    const next = new FileStateProvider(file);
    expect(next.getState('a')).toBe('1');
    expect(next.getState('b')).toBe('2');
  });

  it('a state file that cannot be read throws a clear error', () => {
    expect(() => new FileStateProvider(dir).getState('x')).toThrow(
      `Cannot read the state file ${dir}`
    );
  });

  it('reset removes the state file', () => {
    const file = join(dir, 'reset.json');
    const provider = new FileStateProvider(file);
    provider.setState(State.CacheS3ExactHit, 'true');
    provider.reset();
    expect(provider.getState(State.CacheS3ExactHit)).toBe('');
    expect(() => readFileSync(file)).toThrow();
    // A missing file is not an error.
    expect(() => provider.reset()).not.toThrow();
  });

  it('missing or corrupt state file reads as empty', () => {
    const missing = new FileStateProvider(join(dir, 'nope.json'));
    expect(missing.getState('x')).toBe('');

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    const err = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(new FileStateProvider(bad).getState('x')).toBe('');
    expect(String(err.mock.calls[0]?.[0])).toContain('warning: ');
  });
});
