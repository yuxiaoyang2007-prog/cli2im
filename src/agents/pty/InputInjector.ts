export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const CTRL_U = "\x15";

export interface InputWriteTarget {
  write(data: string): void | Promise<void>;
}

export interface InputResult {
  ok: boolean;
  bytes: number;
  error?: string;
}

export class InputInjector {
  private tail: Promise<InputResult> = Promise.resolve({ ok: true, bytes: 0 });

  constructor(private readonly target: InputWriteTarget) {}

  send(text: string): Promise<InputResult> {
    const next = this.tail
      .catch(() => ({ ok: false, bytes: 0 }))
      .then(() => this.sendNow(text));
    this.tail = next;
    return next;
  }

  private async sendNow(text: string): Promise<InputResult> {
    try {
      validateInput(text);
      await this.target.write(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}\r`);
      return { ok: true, bytes: Buffer.byteLength(text, "utf8") };
    } catch (error) {
      await this.clearInput();
      return {
        ok: false,
        bytes: 0,
        error: error instanceof Error ? error.message : "Input injection failed",
      };
    }
  }

  private async clearInput(): Promise<void> {
    try {
      await this.target.write(CTRL_U);
    } catch {
      // The caller receives the original injection failure.
    }
  }
}

export function validateInput(text: string): void {
  if (text.includes("\x1b")) {
    throw new Error("Input contains ESC");
  }
  if (text.includes("\r")) {
    throw new Error("Input contains bare carriage return");
  }
  if (text.includes("[200~") || text.includes("[201~")) {
    throw new Error("Input contains bracketed-paste sentinel");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new Error("Input contains unsupported control character");
  }
}
