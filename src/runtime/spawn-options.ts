import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { expandHome } from '../media.js';
import { assertAgentsFile } from '../isolation/policy.js';
import type { BotConfig, SpawnOpts } from '../types.js';

export interface ResolveBotSpawnOptsInput {
  allWritable?: string[];
  botConfig: BotConfig;
  workingDirectory: string;
  env?: Record<string, string>;
  model?: string;
  autoApprove?: boolean;
  turnTimeoutMs?: number;
  idleTimeoutMs?: number;
  sandboxMode?: string;
  reasoningEffort?: SpawnOpts['reasoningEffort'];
  initialPrompt?: string;
  addDirs?: string[];
  sandboxExtraRoots?: string[];
  otherProtectedRoots?: string[];
}

export type BotSpawnOptsResolver = (params: ResolveBotSpawnOptsInput) => Promise<SpawnOpts>;

/** Default per-bot runtime instructions file, read from the working directory. */
export const DEFAULT_AGENTS_FILE = 'AGENTS.md';

/** Upper bound on the runtime instructions file size (bytes). */
export const MAX_AGENTS_FILE_BYTES = 256 * 1024;

/**
 * Resolve and read a bot's runtime instructions file (the "agent runtime"
 * AGENTS.md). Returns the trimmed file contents, or `undefined` when the
 * feature is disabled, the file is missing/empty, or it cannot be read — so a
 * missing AGENTS.md never blocks a bot from spawning.
 *
 * Hardening: the path is `lstat`-ed and must be a regular file. This rejects
 * symlinks (so a file dropped into an untrusted workingDirectory — e.g. a
 * cloned repo — cannot point AGENTS.md at a secret like `~/.ssh/id_rsa` and
 * have it silently injected into the system prompt) and special files such as
 * FIFOs/devices (which would hang the read and block the bot from spawning).
 * Oversized files are skipped rather than blindly loaded into the prompt.
 */
export async function readAgentsInstructions(
  agentsFile: string | false | undefined,
  workingDirectory: string,
): Promise<string | undefined> {
  if (agentsFile === false || agentsFile === '') return undefined;
  const candidate = expandHome(agentsFile ?? DEFAULT_AGENTS_FILE);
  const filePath = isAbsolute(candidate) ? candidate : join(workingDirectory, candidate);
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.size > MAX_AGENTS_FILE_BYTES) return undefined;
    const content = await readFile(filePath, 'utf-8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveBotSpawnOpts(params: ResolveBotSpawnOptsInput): Promise<SpawnOpts> {
  const workingDirectory = expandHome(params.workingDirectory);
  const addDirs = params.addDirs?.length
    ? params.addDirs.map((dir) => expandHome(dir))
    : undefined;
  const validatedAgentsFile = params.botConfig.isolation?.enabled
    ? assertAgentsFile(params.botConfig, params.allWritable ?? [workingDirectory, ...(params.botConfig.isolation.writable ?? [])])
    : undefined;
  const appendSystemPrompt = await readAgentsInstructions(
    params.botConfig.isolation?.enabled ? validatedAgentsFile ?? false : params.botConfig.agentsFile,
    workingDirectory,
  );

  return {
    workingDirectory,
    permissionMode: params.botConfig.permissionMode,
    env: params.env,
    model: params.model,
    autoApprove: params.autoApprove,
    turnTimeoutMs: params.turnTimeoutMs,
    idleTimeoutMs: params.idleTimeoutMs,
    sandboxMode: params.sandboxMode,
    reasoningEffort: params.reasoningEffort,
    initialPrompt: params.initialPrompt,
    addDirs,
    appendSystemPrompt,
  };
}

