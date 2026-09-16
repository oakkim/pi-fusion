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
    "After the sidekick returns, review the result before your final response.",
    "",
    "User task:",
    task.trim(),
  ].join("\n");
}

export type FusionCommand =
  | { kind: "set"; mode: FusionMode }
  | { kind: "toggle" }
  | { kind: "once"; prompt: string };

export function parseFusionCommand(args: string): FusionCommand {
  const text = args.trim();
  if (!text) return { kind: "toggle" };
  const lower = text.toLowerCase();
  if (lower === "on" || lower === "forced" || lower === "force") return { kind: "set", mode: "forced" };
  if (lower === "available" || lower === "auto") return { kind: "set", mode: "available" };
  if (lower === "off" || lower === "disable" || lower === "disabled") return { kind: "set", mode: "off" };
  return { kind: "once", prompt: text };
}

export function fusionArgumentCompletions(prefix: string): Array<{ value: string; label: string; description: string }> | null {
  const items = [
    { value: "on", label: "on", description: "Force every prompt through the planner/sidekick split" },
    { value: "available", label: "available", description: "Let the lead decide when to delegate (default)" },
    { value: "off", label: "off", description: "Disable all fusion tools for this session" },
  ];
  const filtered = items.filter((i) => i.value.startsWith(prefix.trim().toLowerCase()));
  return filtered.length > 0 ? filtered : null;
}

export function modeLabel(mode: FusionMode): string {
  if (mode === "forced") return "Fusion forced";
  if (mode === "off") return "Fusion off";
  return "Fusion available";
}
