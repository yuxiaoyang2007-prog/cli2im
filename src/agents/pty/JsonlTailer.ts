import { readFile, stat } from "node:fs/promises";

export class JsonlTailer {
  private offset = 0;
  private pending = "";

  constructor(private readonly filePath: string) {}

  get currentOffset(): number {
    return this.offset;
  }

  // Skip everything already in the file so the next drain() only returns records
  // appended afterward. Required when resuming a session (--resume): the transcript
  // already holds the full prior history, and without this the first drain would
  // replay all of it as if it were the current turn.
  async seekToEnd(): Promise<void> {
    try {
      this.offset = (await stat(this.filePath)).size;
    } catch (error) {
      if (isNotFoundError(error)) {
        this.offset = 0;
        return;
      }
      throw error;
    }
    this.pending = "";
  }

  async drain(): Promise<unknown[]> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    if (size < this.offset) {
      this.offset = 0;
      this.pending = "";
    }
    if (size === this.offset) return [];

    const buffer = await readFile(this.filePath);
    const chunk = buffer.subarray(this.offset).toString("utf8");
    this.offset = buffer.length;

    const combined = this.pending + chunk;
    const lines = combined.split("\n");
    this.pending = combined.endsWith("\n") ? "" : lines.pop() ?? "";

    const records: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line));
    }
    return records;
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT");
}
