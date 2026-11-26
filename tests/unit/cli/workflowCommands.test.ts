import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { CiLogger } from '../../../src/ci/host';
import { withWorkflowCommandsRouted } from '../../../src/cli/workflowCommands';

/** A logger that records each call as "<method>: <text>". */
function recordingLog(): { log: CiLogger; calls: string[] } {
  const calls: string[] = [];
  const record =
    (method: string) =>
    (text = ''): void => {
      calls.push(`${method}: ${text}`);
    };
  return {
    calls,
    log: {
      debug: record('debug'),
      info: record('info'),
      warning: record('warning'),
      error: record('error'),
      startGroup: record('startGroup'),
      endGroup: record('endGroup'),
    },
  };
}

describe('withWorkflowCommandsRouted', () => {
  let written: string[];
  let original: typeof process.stdout.write;

  beforeEach(() => {
    written = [];
    original = process.stdout.write;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = original;
  });

  it('sends each @actions/core workflow command to the logger and not to stdout', async () => {
    const { log, calls } = recordingLog();
    await withWorkflowCommandsRouted(log, async () => {
      core.debug('a debug line');
      core.warning('a warning');
      core.error('an error');
      core.notice('a notice');
      core.startGroup('a group');
      core.endGroup();
    });
    expect(calls).toEqual([
      'debug: a debug line',
      'warning: a warning',
      'error: an error',
      'info: a notice',
      'startGroup: a group',
      'endGroup: ',
    ]);
    expect(written.join('')).not.toContain('::');
  });

  it('decodes the escaped characters of a command message', async () => {
    const { log, calls } = recordingLog();
    await withWorkflowCommandsRouted(log, async () => {
      core.warning('two\nlines and 100%');
    });
    expect(calls).toEqual(['warning: two\nlines and 100%']);
  });

  it('drops add-mask, so a secret value does not reach the log', async () => {
    const { log, calls } = recordingLog();
    await withWorkflowCommandsRouted(log, async () => {
      core.setSecret('s3cr3t-value');
    });
    expect(calls).toEqual([]);
    expect(written.join('')).not.toContain('s3cr3t-value');
  });

  it('passes other text through, also when one write holds a command and text', async () => {
    const { log, calls } = recordingLog();
    await withWorkflowCommandsRouted(log, async () => {
      process.stdout.write('plain line\n');
      process.stdout.write('::debug::first\nkept text\r\n::warning::second\n');
      process.stdout.write(Buffer.from('::debug::bytes\n'));
      process.stdout.write('::unknown-command::stays\n');
    });
    expect(calls).toEqual(['debug: first', 'warning: second']);
    expect(written).toEqual([
      'plain line\n',
      'kept text\r\n',
      '::debug::bytes\n',
      '::unknown-command::stays\n',
    ]);
  });

  it('does not route the text that the logger itself writes', async () => {
    const calls: string[] = [];
    const log: CiLogger = {
      ...recordingLog().log,
      info: (text) => {
        calls.push(text);
        process.stdout.write(`${text}\n`);
      },
    };
    await withWorkflowCommandsRouted(log, async () => {
      core.notice('::warning::not a command');
    });
    expect(calls).toEqual(['::warning::not a command']);
    expect(written).toEqual(['::warning::not a command\n']);
  });

  it('restores process.stdout.write after the call, also when the call throws', async () => {
    const before = process.stdout.write;
    await expect(
      withWorkflowCommandsRouted(recordingLog().log, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(process.stdout.write).toBe(before);
  });
});
