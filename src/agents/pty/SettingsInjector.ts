import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SettingsBuildInput {
  handle: string;
  sessionId?: string;
  // Overrides the user's global effortLevel (e.g. xhigh) for the bot's claude.
  // Callers can tune this per bot; the bridge currently passes "high" by default.
  // Omit to inherit the global setting.
  effortLevel?: string;
}

export interface BuiltSettings {
  settingsPath: string;
  rawPayloadFile: string;
  stopMarkerFile: string;
}

export interface StatuslinePayload {
  sessionId?: string;
  transcriptPath?: string;
  model?: string;
  usage?: unknown;
  rateLimits?: unknown;
}

export interface StopMarker {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  turnSeq: number;
  createdAt?: string;
}

interface SettingsInjectorOptions {
  runtimeDir?: string;
  nodePath?: string;
  resourcesDir?: string;
  permissionsAllow?: string[];
  permissionsDeny?: string[];
}

interface WatchOptions {
  pollIntervalMs?: number;
}

export class SettingsInjector {
  private readonly runtimeDir: string;
  private readonly nodePath: string;
  private readonly resourcesDir: string;
  private readonly permissionsAllow: string[];
  private readonly permissionsDeny: string[];

  constructor(options: SettingsInjectorOptions = {}) {
    this.runtimeDir = options.runtimeDir ?? path.join(tmpdir(), "cc-pty-spike");
    this.nodePath = options.nodePath ?? process.execPath;
    this.resourcesDir = options.resourcesDir ?? defaultResourcesDir();
    this.permissionsDeny = options.permissionsDeny ?? [];
    const denied = new Set(this.permissionsDeny);
    this.permissionsAllow = (options.permissionsAllow ?? DEFAULT_PERMISSIONS_ALLOW)
      .filter((tool) => !denied.has(tool));
  }

  async build(handle: SettingsBuildInput): Promise<BuiltSettings> {
    await mkdir(this.runtimeDir, { recursive: true });
    const rawPayloadFile = path.join(this.runtimeDir, `${handle.handle}-statusline.json`);
    const stopMarkerFile = path.join(this.runtimeDir, `${handle.handle}-stop.json`);
    const settingsPath = path.join(this.runtimeDir, `${handle.handle}-settings.json`);
    const statuslineScript = path.join(this.resourcesDir, "pty-statusline.cjs");
    const stopHookScript = path.join(this.resourcesDir, "pty-stop-hook.cjs");

    const settings = {
      ...(handle.effortLevel ? { effortLevel: handle.effortLevel } : {}),
      statusLine: {
        type: "command",
        command: shellJoin([this.nodePath, statuslineScript, rawPayloadFile]),
        padding: 0,
      },
      permissions: {
        defaultMode: "default",
        allow: [...this.permissionsAllow],
        ...(this.permissionsDeny.length > 0 ? { deny: [...this.permissionsDeny] } : {}),
      },
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: shellJoin([
                  this.nodePath,
                  stopHookScript,
                  stopMarkerFile,
                  handle.sessionId ?? "",
                ]),
              },
            ],
          },
        ],
      },
    };

    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return { settingsPath, rawPayloadFile, stopMarkerFile };
  }

  static async readPayload(filePath: string): Promise<StatuslinePayload> {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    return {
      sessionId: stringField(parsed.session_id),
      transcriptPath: stringField(parsed.transcript_path),
      model: modelField(parsed.model),
      usage: parsed.usage,
      rateLimits: parsed.rate_limits,
    };
  }

  static watchStop(
    filePath: string,
    filter: { sessionId?: string },
    cb: (marker: StopMarker) => void,
    options: WatchOptions = {},
  ): () => void {
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    let disposed = false;
    let lastSeq = 0;

    const poll = async (): Promise<void> => {
      if (disposed) return;
      try {
        await access(filePath, constants.R_OK);
      } catch {
        return;
      }

      let marker: StopMarker;
      try {
        marker = JSON.parse(await readFile(filePath, "utf8")) as StopMarker;
      } catch {
        return;
      }

      if (marker.hook_event_name !== "Stop") return;
      if (filter.sessionId && marker.session_id !== filter.sessionId) return;
      if (!Number.isFinite(marker.turnSeq) || marker.turnSeq <= lastSeq) return;

      lastSeq = marker.turnSeq;
      cb(marker);
    };

    const timer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
    void poll();

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }
}

const DEFAULT_PERMISSIONS_ALLOW = ["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "LS"];

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function modelField(value: unknown): string | undefined {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  return stringField(value) ?? stringField(record?.id) ?? stringField(record?.display_name);
}

export function shellJoin(parts: string[]): string {
  return parts.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
}

function defaultResourcesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../resources"),
    path.resolve(here, "resources"),
    path.resolve(process.cwd(), "resources"),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "pty-statusline.cjs"))) ?? candidates[0];
}
