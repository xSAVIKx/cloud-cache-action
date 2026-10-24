import type { summary } from '@actions/core';
import type { RefCandidates } from '../core/refs';
import type { IStateProvider } from '../state';
import { GitHubActionsHost } from './github';

type SummaryTableRows = Parameters<typeof summary.addTable>[0];

export interface InputOptions {
  required?: boolean;
  trimWhitespace?: boolean;
}

export type CiRefs = RefCandidates;

export interface CiContext {
  platform: 'github' | 'bitbucket' | 'generic';
  repository: string;
  refs: CiRefs;
  eventName?: string;
  workspace: string;
  homeDir: string;
  runnerOs: string;
  /** The environment this context was read from. */
  env: NodeJS.ProcessEnv;
}

export interface CiLogger {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  startGroup(title: string): void;
  endGroup(): void;
}

/** The part of the job summary API that the action uses. */
export interface SummaryWriter {
  addHeading(text: string, level?: number): SummaryWriter;
  addRaw(text: string, addEOL?: boolean): SummaryWriter;
  addTable(rows: SummaryTableRows): SummaryWriter;
  addDetails(label: string, content: string): SummaryWriter;
  emptyBuffer(): SummaryWriter;
  write(): Promise<unknown>;
}

/** Everything the action needs from the CI system it runs on. */
export interface CiHost {
  context(): CiContext;
  input(name: string, options?: InputOptions): string;
  setOutput(name: string, value: unknown): void;
  setFailed(message: string | Error): void;
  state: IStateProvider;
  log: CiLogger;
  /** Undefined when the host has no job summary. */
  summary?: SummaryWriter;
}

let current: CiHost | undefined;

/** The active host. The GitHub Actions host is created on first use. */
export function getHost(): CiHost {
  current ??= new GitHubActionsHost();
  return current;
}

/** Sets the active host. Pass undefined to go back to the default. */
export function setHost(host: CiHost | undefined): void {
  current = host;
}
