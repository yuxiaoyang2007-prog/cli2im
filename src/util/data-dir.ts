import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';

export function getCli2imDataDir(): string {
  return process.env.CLI2IM_DATA_DIR || join(homedir(), '.cli2im');
}

export function ensurePrivateDirectorySync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
