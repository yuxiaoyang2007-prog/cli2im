import type { InputInjector } from "./InputInjector.js";
import { PtyScreenRenderer } from "./screen.js";
import type { AgentEvent } from "../../types.js";
import type { TurnDecision } from "./TurnController.js";

export interface InteractiveSessionCallbacks {
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onDecision?: (decision: TurnDecision) => void | Promise<void>;
}

export interface WaitForTurnInput {
  onEvents?: (events: AgentEvent[]) => void | Promise<void>;
}

export interface SlashCommandResult {
  command: string;
  output: string;
}

export interface SlashCommandOptions {
  dismissModal?: boolean;
}

export interface SlashCommandRunner {
  write(data: string): void | Promise<void>;
  onData(cb: (chunk: string) => void): () => void;
}

export type InteractiveInputInjector = Pick<InputInjector, "send">;

export interface InteractiveClaudeSessionOptions {
  injector: InteractiveInputInjector;
  waitForTurn: (input?: WaitForTurnInput) => Promise<TurnDecision>;
  beginTurn?: () => void;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onDecision?: (decision: TurnDecision) => void | Promise<void>;
  onTurnDeadline?: () => TurnDecision | undefined | Promise<TurnDecision | undefined>;
  turnTimeoutMs?: number;
  onDispose?: () => void | Promise<void>;
  slash?: {
    runner: SlashCommandRunner;
    quietMs?: number;
    timeoutMs?: number;
    cols?: number;
    rows?: number;
  };
}

export class InteractiveClaudeSession {
  private tail: Promise<unknown> = Promise.resolve(undefined);
  private disposed = false;
  private disposePromise?: Promise<void>;
  private readonly turnTimeoutMs: number;

  constructor(private readonly options: InteractiveClaudeSessionOptions) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? 180_000;
  }

  send(userText: string, callbacks: InteractiveSessionCallbacks = {}): Promise<TurnDecision | undefined> {
    if (this.disposed) return Promise.reject(disposedError());
    const next = this.tail
      .catch(() => undefined)
      .then(() => {
        if (this.disposed) throw disposedError();
        return this.sendNow(userText, callbacks);
      });
    this.tail = next;
    return next;
  }

  runSlashCommand(command: string, options: SlashCommandOptions = {}): Promise<SlashCommandResult> {
    if (this.disposed) return Promise.reject(disposedError());
    const next = this.tail
      .catch(() => undefined)
      .then(() => {
        if (this.disposed) throw disposedError();
        return this.runSlashCommandNow(command, options);
      });
    this.tail = next;
    return next;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = Promise.resolve(this.options.onDispose?.()).then(() => undefined);
    return this.disposePromise;
  }

  private sendNow(userText: string, callbacks: InteractiveSessionCallbacks): Promise<TurnDecision> {
    return withTimeout(
      this.sendNowUnchecked(userText, callbacks),
      this.turnTimeoutMs,
      () => this.deadlineDecision(),
    );
  }

  private async sendNowUnchecked(userText: string, callbacks: InteractiveSessionCallbacks): Promise<TurnDecision> {
    this.options.beginTurn?.();
    const injected = await this.options.injector.send(userText);
    if (!injected.ok) {
      const decision: TurnDecision = {
        branch: "error",
        events: [{ type: "error", message: injected.error ?? "Input injection failed" }],
      };
      await this.emitDecision(decision, callbacks);
      return decision;
    }

    let streamedCount = 0;
    const decision = await this.options.waitForTurn({
      onEvents: async (events) => {
        streamedCount += events.length;
        await this.emitEvents(events, callbacks);
      },
    });
    await this.emitDecision({ ...decision, events: decision.events.slice(streamedCount) }, callbacks, decision);
    return decision;
  }

  private async deadlineDecision(): Promise<TurnDecision> {
    try {
      const fallback = await withTimeout(
        Promise.resolve(this.options.onTurnDeadline?.()),
        Math.min(this.turnTimeoutMs, 1_000),
        () => undefined,
      );
      if (fallback) return fallback;
    } catch {
      // Fall through to the clear timeout decision. The queue must advance.
    }
    return {
      branch: "error",
      events: [{ type: "error", message: `Turn timed out after ${this.turnTimeoutMs}ms` }],
      elapsedMs: this.turnTimeoutMs,
      reason: "turn deadline exceeded",
    };
  }

  private async runSlashCommandNow(command: string, options: SlashCommandOptions): Promise<SlashCommandResult> {
    const slash = this.options.slash;
    if (!slash) throw new Error("Slash commands are not available for this session");
    const normalized = command.trim();
    validateSlashCommand(normalized);

    const screen = new PtyScreenRenderer({ cols: slash.cols, rows: slash.rows });
    const quietMs = slash.quietMs ?? 1_000;
    const timeoutMs = slash.timeoutMs ?? 20_000;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let off = () => {};

    const output = await new Promise<string>((resolve, reject) => {
      const finish = () => {
        if (settled) return;
        settled = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        off();
        screen.renderedText().then(resolve, reject);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        off();
        reject(error);
      };
      const scheduleQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };

      off = slash.runner.onData((chunk) => {
        screen.write(chunk).catch(fail);
        scheduleQuiet();
      });
      timeoutTimer = setTimeout(finish, timeoutMs);
      scheduleQuiet();

      try {
        Promise.resolve(slash.runner.write(`${normalized}\r`)).catch(fail);
      } catch (error) {
        fail(error);
      }
    });

    if (options.dismissModal ?? true) {
      // Built-in slash commands (/status, /context, /model picker, ...) leave a
      // modal panel open in the TUI. Send Esc (best-effort) to return to a clean prompt.
      try {
        await Promise.resolve(slash.runner.write("\x1b"));
        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch {
        // best-effort: a failed dismiss must not fail the command result
      }
    }

    return { command: normalized, output };
  }

  private async emitDecision(
    emission: TurnDecision,
    callbacks: InteractiveSessionCallbacks,
    originalDecision = emission,
  ): Promise<void> {
    await this.emitEvents(emission.events, callbacks);
    await this.options.onDecision?.(originalDecision);
    await callbacks.onDecision?.(originalDecision);
  }

  private async emitEvents(events: AgentEvent[], callbacks: InteractiveSessionCallbacks): Promise<void> {
    for (const event of events) {
      await this.options.onEvent?.(event);
      await callbacks.onEvent?.(event);
    }
  }
}

export function stripPtyOutput(input: string): string {
  return input
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function validateSlashCommand(command: string): void {
  if (!command.startsWith("/")) {
    throw new Error("Slash command must start with /");
  }
  if (command.includes("\x1b") || command.includes("\r") || command.includes("\n")) {
    throw new Error("Slash command contains unsupported control character");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) {
    throw new Error("Slash command contains unsupported control character");
  }
}

function disposedError(): Error {
  return new Error("Session is disposed");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      Promise.resolve(onTimeout()).then(resolve, reject);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
