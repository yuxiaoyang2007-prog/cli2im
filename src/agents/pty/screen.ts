// @xterm/headless is CommonJS — named import (`{ Terminal }`) fails at runtime
// under tsx/Node ESM ("does not provide an export named 'Terminal'"), even
// though vitest's interop tolerates it. Use the default import (module.exports).
import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

export interface PtyScreenRendererOptions {
  cols?: number;
  rows?: number;
}

export class PtyScreenRenderer {
  private readonly terminal: InstanceType<typeof Terminal>;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: PtyScreenRendererOptions = {}) {
    this.terminal = new Terminal({
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      allowProposedApi: true,
    });
  }

  write(chunk: string): Promise<void> {
    this.tail = this.tail.then(() => new Promise<void>((resolve) => {
      this.terminal.write(chunk, resolve);
    }));
    return this.tail;
  }

  async renderedText(): Promise<string> {
    await this.tail;
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];

    for (let row = buffer.viewportY; row < buffer.viewportY + this.terminal.rows; row += 1) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.trim().length === 0) continue;
      lines.push(text.trimEnd());
    }

    return lines.join("\n").trim();
  }
}
