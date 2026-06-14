import { EventMapper } from "./EventMapper.js";
import type { JsonlTailer } from "./JsonlTailer.js";
import type { AgentEvent, TokenUsage } from "../../types.js";

export type TurnBranch = "waiting" | "result" | "empty_result" | "needs_input" | "error" | "ignored";

export interface TurnDecision {
  branch: TurnBranch;
  events: AgentEvent[];
  sessionId?: string;
  transcriptPath?: string;
  elapsedMs?: number;
  reason?: string;
}

export interface TurnControllerOptions {
  sessionId?: string;
  transcriptPath?: string;
  tailer: JsonlTailer;
  maxTurnMs?: number;
  stopDrainGraceMs?: number;
  stopDrainPollMs?: number;
}

export interface FallbackInput {
  elapsedMs: number;
  ptyReady: boolean;
  prompt?: string;
}

export class TurnController {
  private readonly mapper = new EventMapper();
  private readonly maxTurnMs: number;
  private readonly stopDrainGraceMs: number;
  private readonly stopDrainPollMs: number;
  private startMs = 0;
  private events: AgentEvent[] = [];
  private openToolUseIds = new Set<string>();
  private recordIndex = 0;
  private lastToolResultIndex = -1;
  private terminalAssistantIndex = -1;
  private terminalAssistantHasText = false;
  private lastStopSeq = 0;
  private sessionId?: string;
  private transcriptPath?: string;

  constructor(private readonly options: TurnControllerOptions) {
    this.sessionId = options.sessionId;
    this.transcriptPath = options.transcriptPath;
    this.maxTurnMs = options.maxTurnMs ?? 180_000;
    this.stopDrainGraceMs = options.stopDrainGraceMs ?? 3_000;
    this.stopDrainPollMs = options.stopDrainPollMs ?? 100;
  }

  beginTurn(): void {
    this.startMs = Date.now();
    this.events = [];
    this.mapper.resetUsage();
    this.openToolUseIds.clear();
    this.recordIndex = 0;
    this.lastToolResultIndex = -1;
    this.terminalAssistantIndex = -1;
    this.terminalAssistantHasText = false;
    this.lastStopSeq = 0;
  }

  async handleStop(rawMarker: unknown): Promise<TurnDecision> {
    const marker = normalizeMarker(rawMarker);
    if (marker.hookEventName !== "Stop") {
      return this.decision("ignored", [], "non-stop marker");
    }
    if (this.sessionId && marker.sessionId && marker.sessionId !== this.sessionId) {
      return this.decision("ignored", [], "marker belongs to another session");
    }
    if (!Number.isFinite(marker.turnSeq) || marker.turnSeq <= this.lastStopSeq) {
      return this.decision("ignored", [], "duplicate or stale Stop marker");
    }

    this.lastStopSeq = marker.turnSeq;
    this.sessionId = this.sessionId ?? marker.sessionId;
    this.transcriptPath = this.transcriptPath ?? marker.transcriptPath;

    const deadline = Date.now() + this.stopDrainGraceMs;
    for (;;) {
      this.observeRecords(await this.options.tailer.drain());
      if (this.hasTerminalAssistantResult()) {
        return this.finalizeFromStop();
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(this.stopDrainPollMs, remainingMs));
    }
    return this.finalizeFromStop();
  }

  observeRecords(records: unknown[]): AgentEvent[] {
    const mapped: AgentEvent[] = [];
    for (const record of records) {
      this.recordIndex += 1;
      this.updateOffsetModel(record, this.recordIndex);
      const events = this.mapper.mapRecord(record);
      mapped.push(...events);
      this.events.push(...events);
    }
    return mapped;
  }

  evaluateFallback(input: FallbackInput): TurnDecision {
    if (input.prompt && input.ptyReady) {
      return this.decision("needs_input", [], input.prompt, input.elapsedMs);
    }
    if (input.elapsedMs >= this.maxTurnMs) {
      return this.decision("error", [{ type: "error", message: "Turn timed out before Stop hook" }], undefined, input.elapsedMs);
    }
    return this.decision("waiting", [], undefined, input.elapsedMs);
  }

  finalizeOnDeadline(elapsedMs = this.maxTurnMs): TurnDecision {
    if (this.hasTerminalAssistantResult()) {
      return this.decision("result", [...this.events, this.resultEvent()], undefined, elapsedMs);
    }
    return this.decision("error", [{ type: "error", message: `Turn timed out after ${elapsedMs}ms` }], "turn deadline exceeded", elapsedMs);
  }

  private finalizeFromStop(): TurnDecision {
    if (this.openToolUseIds.size > 0) {
      return this.decision("waiting", []);
    }

    if (this.hasTerminalAssistantResult()) {
      return this.decision("result", [...this.events, this.resultEvent()]);
    }

    return this.decision("empty_result", [...this.events, this.resultEvent()]);
  }

  private hasTerminalAssistantResult(): boolean {
    return this.openToolUseIds.size === 0
      && this.terminalAssistantHasText
      && this.terminalAssistantIndex > this.lastToolResultIndex;
  }

  private updateOffsetModel(record: unknown, index: number): void {
    const value = asRecord(record);
    if (!value) return;
    const type = stringField(value.type);
    const sessionId = stringField(value.session_id) ?? stringField(value.sessionId);
    if (sessionId) this.sessionId = this.sessionId ?? sessionId;

    const message = asRecord(value.message) ?? value;
    const blocks = Array.isArray(message.content)
      ? message.content.flatMap((block) => {
        const recordBlock = asRecord(block);
        return recordBlock ? [recordBlock] : [];
      })
      : [];

    if (type === "assistant") {
      let hasToolUse = false;
      let hasText = false;
      for (const block of blocks) {
        if (stringField(block.type) === "tool_use") {
          hasToolUse = true;
          const id = stringField(block.id);
          if (id) this.openToolUseIds.add(id);
        } else if (stringField(block.type) === "text" && (stringField(block.text) ?? "").length > 0) {
          hasText = true;
        }
      }
      if (!hasToolUse) {
        this.terminalAssistantIndex = index;
        this.terminalAssistantHasText = hasText;
      }
      return;
    }

    if (type === "user") {
      for (const block of blocks) {
        if (stringField(block.type) !== "tool_result") continue;
        const id = stringField(block.tool_use_id) ?? stringField(block.id);
        if (id) this.openToolUseIds.delete(id);
        this.lastToolResultIndex = index;
      }
    }
  }

  private resultEvent(): AgentEvent {
    return {
      type: "result",
      sessionId: this.sessionId ?? "",
      usage: cleanUsage(this.mapper.latestUsage),
    };
  }

  private decision(branch: TurnBranch, events: AgentEvent[], reason?: string, elapsedMs?: number): TurnDecision {
    return {
      branch,
      events,
      sessionId: this.sessionId,
      transcriptPath: this.transcriptPath,
      elapsedMs,
      reason,
    };
  }
}

function normalizeMarker(value: unknown): {
  hookEventName?: string;
  sessionId?: string;
  transcriptPath?: string;
  turnSeq: number;
} {
  const record = asRecord(value) ?? {};
  return {
    hookEventName: stringField(record.hook_event_name),
    sessionId: stringField(record.session_id),
    transcriptPath: stringField(record.transcript_path),
    turnSeq: typeof record.turnSeq === "number" ? record.turnSeq : Number(record.turnSeq),
  };
}

function cleanUsage(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
