import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { State } from '../constants';
import type { IStateProvider } from '../state';

/** Keeps the state of a run in a JSON file, so a later process can read it. */
export class FileStateProvider implements IStateProvider {
  constructor(private readonly path: string) {}

  private read(): Record<string, string> {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw new Error(`Cannot read the state file ${this.path}`, { cause: error });
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      // Falls through to the warning.
    }
    process.stderr.write(`warning: ignoring the unreadable state file ${this.path}\n`);
    return {};
  }

  getState(key: string): string {
    const value = this.read()[key];
    return typeof value === 'string' ? value : '';
  }

  setState(key: string, value: string): void {
    const state = this.read();
    state[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state));
  }

  /** Removes the state file. A missing file is not an error. */
  reset(): void {
    rmSync(this.path, { force: true });
  }

  getCacheState(): string {
    return this.getState(State.CacheMatchedKey);
  }
}
