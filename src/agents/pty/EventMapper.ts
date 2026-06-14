import type { AgentEvent, TokenUsage } from "../../types.js";

export interface EventMappingState {
  latestSessionId?: string;
  latestUsage?: TokenUsage;
  toolNamesById: Map<string, string>;
}

export class EventMapper {
  readonly toolNamesById = new Map<string, string>();
  latestSessionId?: string;
  latestUsage?: TokenUsage;

  resetUsage(): void {
    this.latestUsage = undefined;
  }

  mapRecord(record: unknown): AgentEvent[] {
    const state: EventMappingState = {
      latestSessionId: this.latestSessionId,
      latestUsage: this.latestUsage,
      toolNamesById: this.toolNamesById,
    };
    const events = mapJsonlRecord(record, state);
    this.latestSessionId = state.latestSessionId;
    this.latestUsage = state.latestUsage;
    return events;
  }
}

export function mapJsonlRecord(record: unknown, state: EventMappingState): AgentEvent[] {
  const value = asRecord(record);
  if (!value) return [];

  const sessionId = stringField(value.session_id) ?? stringField(value.sessionId);
  if (sessionId) state.latestSessionId = sessionId;

  const events: AgentEvent[] = [];
  const type = stringField(value.type);

  if (type === "assistant") {
    const message = asRecord(value.message) ?? value;
    const usage = asRecord(message.usage);
    if (usage) state.latestUsage = mapUsage(usage);
    for (const block of readContentBlocks(message.content)) {
      const blockType = stringField(block.type);
      if (blockType === "text") {
        events.push({ type: "text", content: stringField(block.text) ?? "" });
      } else if (blockType === "thinking") {
        events.push({ type: "thinking", content: stringField(block.thinking) ?? "" });
      } else if (blockType === "tool_use") {
        const id = stringField(block.id) ?? "";
        const name = stringField(block.name) ?? "";
        state.toolNamesById.set(id, name);
        events.push({ type: "tool_use", id, name, input: asRecord(block.input) ?? {} });
      }
    }
    return events;
  }

  if (type === "user") {
    const message = asRecord(value.message) ?? value;
    for (const block of readContentBlocks(message.content)) {
      if (stringField(block.type) !== "tool_result") continue;
      const id = stringField(block.tool_use_id) ?? stringField(block.id) ?? "";
      events.push({
        type: "tool_result",
        id,
        name: state.toolNamesById.get(id) ?? "",
        output: stringifyToolResultContent(block.content),
        isError: booleanField(block.is_error),
      });
    }
    return events;
  }

  if (type === "result") {
    const usage = mapUsage(asRecord(value.usage) ?? {});
    state.latestUsage = usage;
    events.push({
      type: "result",
      sessionId: sessionId ?? state.latestSessionId ?? "",
      usage,
    });
  }

  return events;
}

export function mapUsage(raw: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: numberField(raw.input_tokens) ?? 0,
    outputTokens: numberField(raw.output_tokens) ?? 0,
    cacheReadTokens: numberField(raw.cache_read_input_tokens),
    cacheWriteTokens: numberField(raw.cache_creation_input_tokens),
  };
}

function readContentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const record = asRecord(block);
    return record ? [record] : [];
  });
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
