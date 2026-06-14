export type PromptKind = "trust_folder" | "plan_mode";

export type PromptDetection =
  | { kind: PromptKind; action: "confirm"; input: string }
  | { kind: PromptKind; action: "fail"; message: string };

export class PromptDetector {
  static detect(raw: string): PromptDetection | undefined {
    const text = raw.toLowerCase();
    if (text.includes("trust") && text.includes("files") && text.includes("folder")) {
      return { kind: "trust_folder", action: "confirm", input: "y\r" };
    }
    if (text.includes("proceed with this plan") || (text.includes("plan mode") && text.includes("confirm"))) {
      return {
        kind: "plan_mode",
        action: "fail",
        message: "Plan mode confirmation requires CC review",
      };
    }
    return undefined;
  }
}
