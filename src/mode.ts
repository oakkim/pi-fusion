/** Forced/available/off modes. Pure helpers (unit-tested); wiring lives in index.ts. */

import { LEAD_PROMPT_PREFIX } from "./prompts.ts";

export type FusionMode = "available" | "forced" | "off";

export function normalizeMode(value: unknown): FusionMode {
  return value === "forced" || value === "off" || value === "available" ? value : "available";
}

export const FORCE_MARKER = "Delegate the following task to the sidekick before answering.";

export function isForcePrompt(text: string): boolean {
  return text.includes(FORCE_MARKER);
}

export function forceFusionPrompt(task: string): string {
  return [
    LEAD_PROMPT_PREFIX,
    "",
    FORCE_MARKER,
    "The worker starts asynchronously: acknowledge the IDs and keep the conversation available instead of polling.",
    "When its completion result arrives, personally inspect the actual changes before approval, merge, or a final completion claim.",
    "",
    "User task:",
    task.trim(),
  ].join("\n");
}

export function modeLabel(mode: FusionMode): string {
  if (mode === "forced") return "Fusion forced";
  if (mode === "off") return "Fusion off";
  return "Fusion available";
}
