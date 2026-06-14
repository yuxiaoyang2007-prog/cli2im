import { homedir } from 'node:os';
import { join } from 'node:path';

export function getCli2imDataDir(): string {
  return process.env.CLI2IM_DATA_DIR || join(homedir(), '.cli2im');
}
