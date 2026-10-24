import type { RefCandidates } from '../core/refs';
import type { IStateProvider } from '../state';
import type { RunnerOs } from './env';
import { GitHubActionsHost } from './github';

/** A table cell. The shape matches the table cell of the job summary API. */
export interface SummaryTableCell {
  data: string;
  header?: boolean;
  colspan?: string;
  rowspan?: string;
}

export type SummaryTableRow = (SummaryTableCell | string)[];

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
  runnerOs: RunnerOs;
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
  addTable(rows: SummaryTableRow[]): SummaryWriter;
  addDetails(label: string, content: string): SummaryWriter;
  emptyBuffer(): SummaryWriter;
  write(): Promise<unknown>;
}

/** Everything the action needs from the CI system it runs on. */
export interface CiHost {
  context(): CiContext;
  input(name: string, options?: InputOptions): string;
  setOutput(name: string, value: unknown): void;
  /**
   * Reports the step as failed. Every host must set `process.exitCode = 1`: the entry points end
   * with `process.exit(process.exitCode ?? 0)`.
   */
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
