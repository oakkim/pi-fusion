/** Shared visible request rendering for Lead tools. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeMonitorText } from "./monitor.ts";

const FUSION_CALL_PREVIEW_CHARS = 240;
const FUSION_CALL_EXPANDED_CHARS = 8_000;

function sanitizeFusionCallText(value: unknown): string {
  return sanitizeMonitorText(value, Number.MAX_SAFE_INTEGER).trim();
}

function clipFusionCallText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function formatFusionCallRequest(value: unknown, expanded: boolean): string {
  const text = sanitizeFusionCallText(value);
  if (!text) return "…";
  if (!expanded) return clipFusionCallText(text.replace(/\s+/g, " "), FUSION_CALL_PREVIEW_CHARS);
  if (text.length <= FUSION_CALL_EXPANDED_CHARS) return text;
  const marker = "\n… [truncated]";
  return `${text.slice(0, FUSION_CALL_EXPANDED_CHARS - marker.length)}${marker}`;
}

export function fusionCallMetadata(name: string, value: unknown): string | undefined {
  const text = sanitizeFusionCallText(value).replace(/\s+/g, " ");
  return text ? `${name}=${clipFusionCallText(text, 80)}` : undefined;
}

export function fusionCallArgument(args: unknown, name: string): unknown {
  if (!args || typeof args !== "object") return undefined;
  return (args as Record<string, unknown>)[name];
}

export function renderFusionRequestCall(
  title: string,
  requestName: "task" | "message" | "question",
  request: unknown,
  metadata: Array<string | undefined>,
  theme: Theme,
  expanded: boolean,
): Text {
  const details = metadata.filter((item): item is string => Boolean(item)).join(" · ");
  let text = theme.fg("toolTitle", theme.bold(title));
  if (details) text += ` ${theme.fg("muted", details)}`;
  text += `\n${theme.fg("muted", `${requestName}:`)} ${theme.fg("toolOutput", formatFusionCallRequest(request, expanded))}`;
  return new Text(text, 0, 0);
}
