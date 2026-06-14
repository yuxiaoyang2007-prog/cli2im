import { EventEmitter } from "node:events";

export type PtyState = "starting" | "ready" | "busy" | "exited";

export interface PtyClaudeRunnerOptions {
  claudeBin?: string;
  cwd: string;
  env?: Record<string, string>;
  quietMs?: number;
  cols?: number;
  rows?: number;
}

export interface PtySpawnInput {
  settingsPath: string;
  resumeSessionId?: string;
  model?: string;
}

// Claude Code injects these into any child process it spawns. If the bridge is
// launched from inside a Claude Code session (or a shell that already has them),
// the PTY `claude` inherits CLAUDECODE / CLAUDE_CODE_* and starts as a NESTED
// child session — in that mode it does not write the transcript JSONL we tail, so
// every turn comes back empty. Strip them so it starts as a fresh top-level session.
export function sanitizeChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key === "AI_AGENT" || key === "CLAUDE_EFFORT" || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  return env;
}

interface PtyLike {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(cb: (chunk: string) => void): { dispose(): void };
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export class PtyClaudeRunner {
  private readonly events = new EventEmitter();
  private readonly quietMs: number;
  private pty?: PtyLike;
  private quietTimer?: ReturnType<typeof setTimeout>;
  private state: PtyState = "starting";

  constructor(private readonly options: PtyClaudeRunnerOptions) {
    this.quietMs = options.quietMs ?? 800;
  }

  static buildArgs(input: PtySpawnInput): string[] {
    return [
      "--settings",
      input.settingsPath,
      ...(input.model ? ["--model", input.model] : []),
      ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
    ];
  }

  get pid(): number | undefined {
    return this.pty?.pid;
  }

  get currentState(): PtyState {
    return this.state;
  }

  async spawn(input: PtySpawnInput): Promise<void> {
    const ptyModule = await import("node-pty");
    const args = PtyClaudeRunner.buildArgs(input);
    this.setState("starting");
    this.pty = ptyModule.spawn(this.options.claudeBin ?? "claude", args, {
      name: "xterm-256color",
      cols: this.options.cols ?? 120,
      rows: this.options.rows ?? 40,
      cwd: this.options.cwd,
      env: sanitizeChildEnv({ ...process.env, ...this.options.env }),
    }) as PtyLike;

    this.pty.onData((chunk) => {
      if (this.state === "starting") {
        this.setState("ready");
      } else {
        this.markBusy();
      }
      this.events.emit("data", chunk);
    });

    this.pty.onExit((event) => {
      if (this.quietTimer) clearTimeout(this.quietTimer);
      this.setState("exited");
      this.events.emit("exit", event);
    });
  }

  write(data: string): void {
    if (!this.pty) throw new Error("PTY is not spawned");
    this.pty.write(data);
  }

  onData(cb: (chunk: string) => void): () => void {
    this.events.on("data", cb);
    return () => this.events.off("data", cb);
  }

  onState(cb: (state: PtyState) => void): () => void {
    this.events.on("state", cb);
    cb(this.state);
    return () => this.events.off("state", cb);
  }

  onExit(cb: (event: { exitCode: number; signal?: number }) => void): () => void {
    this.events.on("exit", cb);
    return () => this.events.off("exit", cb);
  }

  kill(): void {
    if (!this.pty) return;
    this.pty.kill();
  }

  private markBusy(): void {
    this.setState("busy");
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      if (this.state === "busy") this.setState("ready");
    }, this.quietMs);
  }

  private setState(state: PtyState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.emit("state", state);
  }
}
