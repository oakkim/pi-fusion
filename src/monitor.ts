import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { formatUsageFooter, type UsageSummary, zeroUsage } from "./cost.ts";
import type { LiveActivity, PaneTranscriptItem } from "./pane.ts";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const MONITOR_SCHEMA_VERSION = 2 as const;

/** Public transcript shape written to the owner-only monitor snapshot. */
export type MonitorTranscriptItem = PaneTranscriptItem | {
  /** Legacy v1 rows are accepted and normalized by the defensive parser. */
  kind?: undefined;
  role: "LEAD" | "SIDEKICK" | "TOOL";
  text: string;
};

export interface MonitorSteeringSnapshot {
  id: string;
  turnId: string;
  status: "pending" | "injected";
  preview: string;
  enqueuedAt: number;
}

export interface MonitorQueueSnapshot {
  id: string;
  status: "queued";
  strategy: "queue" | "interrupt";
  preview: string;
  enqueuedAt: number;
  interruptedTurnId?: string;
}

export interface MonitorCoordinationSnapshot {
  steering: MonitorSteeringSnapshot[];
  queue: MonitorQueueSnapshot[];
}

export interface MonitorWorkerTelemetry {
  /** Cumulative successful executor-turn usage for this worker. */
  usage?: UsageSummary;
  /** Latest successful assistant usage, used for the CH footer component. */
  latestUsage?: UsageSummary;
  latestExecutor?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextKnown?: boolean;
  subscription?: boolean;
  automaticCompaction?: boolean;
}

export interface MonitorWorkerSnapshot {
  id: string;
  label?: string;
  status: string;
  generation: number;
  executor: string;
  activeTurnId?: string;
  createdAt: number;
  worktree?: { branch: string; path: string };
  /** Kept for old snapshots and cheap list badges. */
  queuedFollowups: number;
  steeringUpdates: number;
  coordination?: MonitorCoordinationSnapshot;
  history: MonitorTranscriptItem[];
  telemetry?: MonitorWorkerTelemetry;
  live?: LiveActivity;
}

export interface MonitorSnapshotPayload {
  schemaVersion: 1 | 2;
  sessionId: string;
  cwd: string;
  themeName?: string;
  selectedWorkerId?: string;
  workers: MonitorWorkerSnapshot[];
}

export interface MonitorSnapshot extends MonitorSnapshotPayload {
  updatedAt: number;
  connected: boolean;
  closed?: boolean;
  closeReason?: string;
  ownerPid: number;
}

export interface MonitorViewState {
  selectedWorkerId?: string;
  scroll: number;
  follow: boolean;
}

export interface RenderedMonitor {
  lines: string[];
  selectedWorkerId?: string;
  scroll: number;
  maxScroll: number;
}

export interface MonitorLaunchPlan {
  kind: "ghostty" | "terminal";
  command: string;
  args: string[];
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const SNAPSHOT_WRITE_DELAY_MS = 80;
const MONITOR_HEARTBEAT_MS = 2_000;
export const MONITOR_STALE_AFTER_MS = 30_000;
const HISTORY_TEXT_MAX = 8_000;
const TOOL_ARGUMENTS_MAX = 2_000;
const TOOL_OUTPUT_MAX = 4_000;
const PREVIEW_MAX = 180;

function style(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Strip terminal controls before rendering data originating in tools/models. */
export function sanitizeMonitorText(value: unknown, max = HISTORY_TEXT_MAX): string {
  const text = stripTerminalSequences(typeof value === "string" ? value : String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r/g, "");
  return text.length > max ? `...${text.slice(-(Math.max(0, max - 3)))}` : text;
}

function safeLine(value: unknown, max = HISTORY_TEXT_MAX): string {
  return sanitizeMonitorText(value, max).replace(/\n+/g, " ").trim();
}

function padLine(value: string, width: number): string {
  return truncateToWidth(value, Math.max(1, width), "", true);
}

function horizontal(width: number): string {
  return style(DIM, "─".repeat(Math.max(1, width)));
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function statusGlyph(status: string): string {
  if (status === "running") return style(CYAN, "▶");
  if (status === "idle" || status === "completed") return style(GREEN, "✓");
  if (status === "failed") return style(RED, "✗");
  if (status === "interrupted") return style(YELLOW, "■");
  return style(DIM, "○");
}

function toolGlyph(status: string): string {
  if (status === "running") return style(CYAN, "▶");
  if (status === "success") return style(GREEN, "✓");
  return style(RED, "✗");
}

function roleLabel(role: "LEAD" | "SIDEKICK" | "TOOL"): string {
  if (role === "LEAD") return style(BLUE, "LEAD");
  if (role === "SIDEKICK") return style(MAGENTA, "SIDEKICK");
  return style(YELLOW, "TOOL");
}

function wrapPrefixed(prefix: string, text: string, width: number, max = HISTORY_TEXT_MAX): string[] {
  const safe = sanitizeMonitorText(text, max);
  const prefixWidth = visibleWidth(prefix);
  const bodyWidth = Math.max(4, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(safe || "(empty)", bodyWidth);
  return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
}

/** Pi message components may add shell-integration OSC markers after input sanitization. */
function stripGeneratedOsc(lines: string[]): string[] {
  return lines.map((line) => line
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, "")
    .replace(/\u001b\\|\u009c/g, ""));
}

function normalizeTranscriptItem(value: unknown): MonitorTranscriptItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const role = item.role;
  const kind = item.kind;
  if (kind === "user" && role === "LEAD" && typeof item.text === "string") {
    return { kind: "user", role: "LEAD", text: sanitizeMonitorText(item.text) };
  }
  if (kind === "assistant" && role === "SIDEKICK" && typeof item.text === "string") {
    return { kind: "assistant", role: "SIDEKICK", text: sanitizeMonitorText(item.text) };
  }
  if (kind === "tool" && role === "TOOL" && typeof item.id === "string" && typeof item.name === "string") {
    const status = item.status === "success" || item.status === "error" ? item.status : "running";
    return {
      kind: "tool",
      role: "TOOL",
      id: sanitizeMonitorText(item.id, 200),
      name: sanitizeMonitorText(item.name, 200),
      arguments: sanitizeMonitorText(typeof item.arguments === "string" ? item.arguments : "", TOOL_ARGUMENTS_MAX),
      ...(typeof item.output === "string" ? { output: sanitizeMonitorText(item.output, TOOL_OUTPUT_MAX) } : {}),
      status,
    };
  }
  // v1 history was a flat role/text list. Normalize it at the parser boundary
  // so publisher and CLI always operate on one structured shape internally.
  if ((role === "LEAD" || role === "SIDEKICK" || role === "TOOL") && typeof item.text === "string") {
    if (role === "LEAD") return { kind: "user", role, text: sanitizeMonitorText(item.text) };
    if (role === "SIDEKICK") return { kind: "assistant", role, text: sanitizeMonitorText(item.text) };
    return {
      kind: "tool",
      role,
      id: "legacy-tool",
      name: "tool",
      arguments: "",
      output: sanitizeMonitorText(item.text, TOOL_OUTPUT_MAX),
      status: "success",
    };
  }
  return undefined;
}

function normalizedHistory(history: unknown): MonitorTranscriptItem[] | undefined {
  if (!Array.isArray(history)) return undefined;
  const result: MonitorTranscriptItem[] = [];
  for (const item of history.slice(-120)) {
    const normalized = normalizeTranscriptItem(item);
    if (normalized) result.push(normalized);
  }
  return result;
}

function coordinationFor(worker: MonitorWorkerSnapshot): MonitorCoordinationSnapshot {
  const raw = worker.coordination;
  if (raw && Array.isArray(raw.steering) && Array.isArray(raw.queue)) {
    return {
      steering: raw.steering.filter((item) => item && typeof item.id === "string").map((item) => ({
        id: safeLine(item.id, 120),
        turnId: safeLine(item.turnId, 120),
        status: item.status === "injected" ? "injected" : "pending",
        preview: safeLine(item.preview, PREVIEW_MAX),
        enqueuedAt: typeof item.enqueuedAt === "number" ? item.enqueuedAt : 0,
      })),
      queue: raw.queue.filter((item) => item && typeof item.id === "string").map((item) => ({
        id: safeLine(item.id, 120),
        status: "queued" as const,
        strategy: item.strategy === "interrupt" ? "interrupt" as const : "queue" as const,
        preview: safeLine(item.preview, PREVIEW_MAX),
        enqueuedAt: typeof item.enqueuedAt === "number" ? item.enqueuedAt : 0,
        ...(typeof item.interruptedTurnId === "string" ? { interruptedTurnId: safeLine(item.interruptedTurnId, 120) } : {}),
      })),
    };
  }
  // Old snapshots still expose counts; retain the counts without inventing
  // model text. New snapshots always publish the arrays above.
  const steering = Math.max(0, Number.isFinite(worker.steeringUpdates) ? worker.steeringUpdates : 0);
  const queue = Math.max(0, Number.isFinite(worker.queuedFollowups) ? worker.queuedFollowups : 0);
  return {
    steering: steering > 0 ? [{
      id: "legacy-steering",
      turnId: "",
      status: "pending" as const,
      preview: "(legacy snapshot)",
      enqueuedAt: 0,
    }] : [],
    queue: queue > 0 ? [{
      id: "legacy-queue",
      status: "queued" as const,
      strategy: "queue" as const,
      preview: "(legacy snapshot)",
      enqueuedAt: 0,
    }] : [],
  };
}

function telemetryFor(worker: MonitorWorkerSnapshot): MonitorWorkerTelemetry {
  const telemetry = worker.telemetry;
  return {
    usage: telemetry?.usage ?? zeroUsage(),
    latestUsage: telemetry?.latestUsage,
    latestExecutor: telemetry?.latestExecutor,
    contextTokens: telemetry?.contextTokens,
    contextWindow: telemetry?.contextWindow,
    contextKnown: telemetry?.contextKnown === true,
    subscription: telemetry?.subscription === true,
    automaticCompaction: telemetry?.automaticCompaction !== false,
  };
}

function toolSummary(name: string, args: string): string {
  try {
    const value = JSON.parse(args) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return safeLine(args, 90);
    const simple = Object.entries(value)
      .filter(([, item]) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      .slice(0, 2)
      .map(([key, item]) => `${key}=${safeLine(String(item), 38)}`)
      .join(" · ");
    return simple || safeLine(args, 90);
  } catch {
    return safeLine(args, 90);
  }
}

function richMessageLines(item: Extract<MonitorTranscriptItem, { kind: "user" | "assistant" }>, width: number): string[] {
  const text = sanitizeMonitorText(item.text);
  try {
    if (item.kind === "user") {
      // Public Pi component: it supplies the same padded/card-like user
      // treatment as the main application without importing private paths.
      return stripGeneratedOsc(new UserMessageComponent(text, getMarkdownTheme(), 0).render(Math.max(4, width)));
    }
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } as never;
    // Hide thinking by construction and by the component's explicit flag.
    return stripGeneratedOsc(new AssistantMessageComponent(message, true, getMarkdownTheme(), undefined, 0).render(Math.max(4, width)));
  } catch {
    const label = roleLabel(item.role);
    return wrapPrefixed(`${label}  `, text, width);
  }
}

function toolCardLines(item: Extract<MonitorTranscriptItem, { kind: "tool" }>, width: number): string[] {
  const inner = Math.max(4, width);
  const name = safeLine(item.name, 180) || "tool";
  const args = safeLine(item.arguments, TOOL_ARGUMENTS_MAX);
  const summary = args ? toolSummary(name, args) : "";
  const heading = `${toolGlyph(item.status)} ${style(BOLD, name)}${summary ? ` ${style(DIM, `· ${summary}`)}` : ""}`;
  const lines = [padLine(`╭─ ${heading}`, inner)];
  if (args) lines.push(...wrapPrefixed(`${style(DIM, "│ ")}args `, args, inner, TOOL_ARGUMENTS_MAX));
  if (item.output) {
    lines.push(...wrapPrefixed(`${style(DIM, "│ ")}out  `, item.output, inner, TOOL_OUTPUT_MAX));
  }
  const statusLabel = item.status === "running" ? "pending" : item.status;
  lines.push(padLine(`╰─ ${style(DIM, statusLabel)}`, inner));
  return lines;
}

function transcriptLines(worker: MonitorWorkerSnapshot, width: number, now: number): string[] {
  const lines: string[] = [];
  const history = worker.history.flatMap((item) => {
    const normalized = normalizeTranscriptItem(item);
    if (!normalized) return [];
    if (normalized.kind === "tool") return toolCardLines(normalized, width);
    if (normalized.kind === "user" || normalized.kind === "assistant") return richMessageLines(normalized, width);
    const fallback = normalized.role === "LEAD"
      ? { kind: "user" as const, role: "LEAD" as const, text: normalized.text }
      : { kind: "assistant" as const, role: "SIDEKICK" as const, text: normalized.text };
    return richMessageLines(fallback, width);
  });
  lines.push(...history);
  if (worker.live) {
    lines.push("", `${style(BOLD, "Live")} ${style(CYAN, worker.live.phase)} ${style(DIM, formatDuration(now - worker.live.startedAt))}`);
    if (worker.live.text) {
      const liveMessage: Extract<MonitorTranscriptItem, { kind: "assistant" }> = { kind: "assistant", role: "SIDEKICK", text: worker.live.text };
      lines.push(...richMessageLines(liveMessage, width));
    }
    for (const tool of worker.live.tools) {
      lines.push(...toolCardLines({
        kind: "tool",
        role: "TOOL",
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments,
        ...(tool.output ? { output: tool.output } : {}),
        status: tool.status as "running" | "success" | "error",
      }, width));
    }
  }
  if (lines.length === 0) lines.push(style(DIM, "No visible transcript."));
  return lines;
}

function selectedWorker(snapshot: MonitorSnapshot, requestedId: string | undefined): MonitorWorkerSnapshot | undefined {
  return snapshot.workers.find((worker) => worker.id === requestedId)
    ?? [...snapshot.workers].reverse().find((worker) => worker.status === "running")
    ?? snapshot.workers.at(-1);
}

function workerListWindow(workers: MonitorWorkerSnapshot[], selectedIndex: number, height: number): MonitorWorkerSnapshot[] {
  if (height <= 0) return [];
  if (workers.length <= height) return workers;
  const start = clamp(selectedIndex - Math.floor(height / 2), 0, workers.length - height);
  return workers.slice(start, start + height);
}

function coordinationLines(worker: MonitorWorkerSnapshot, width: number, now: number): string[] {
  const coordination = coordinationFor(worker);
  const pending = coordination.steering.filter((item) => item.status === "pending");
  const injected = coordination.steering.filter((item) => item.status === "injected");
  // A pending correction is the most actionable latest item, even when an
  // older injected update happens to be later in the bounded snapshot slice.
  const latest = pending.at(-1) ?? injected.at(-1);
  const next = coordination.queue[0];
  const steeringTotal = Number.isFinite(worker.steeringUpdates) ? Math.max(0, worker.steeringUpdates) : coordination.steering.length;
  const queueTotal = Number.isFinite(worker.queuedFollowups) ? Math.max(0, worker.queuedFollowups) : coordination.queue.length;
  const age = (timestamp: number): string => timestamp > 0 ? formatDuration(Math.max(0, now - timestamp)) : "—";
  const shortId = (id: string): string => id.length > 12 ? id.slice(0, 8) : id;
  const latestPreview = latest
    ? `↗ ${latest.status} · ${age(latest.enqueuedAt)} · ${latest.preview || "(empty)"} · ${shortId(latest.id)}`
    : "—";
  const nextPreview = next
    ? `◷ ${next.strategy} · ${age(next.enqueuedAt)} · ${next.preview || "(empty)"} · ${shortId(next.id)}`
    : "—";
  const lines = [
    `${style(BOLD, "Steering")} ${steeringTotal} (${pending.length} pending · ${injected.length} injected)  ${style(BOLD, "Queue")} ${queueTotal}`,
    `${style(DIM, "latest")} ${latestPreview}`,
    `${style(DIM, "next")} ${nextPreview}`,
  ];
  return lines.map((line) => padLine(line, width));
}

function selectedSummaryLines(worker: MonitorWorkerSnapshot, width: number): string[] {
  const telemetry = telemetryFor(worker);
  const title = safeLine(worker.label || "sidekick", 180);
  const executor = telemetry.latestExecutor || worker.executor;
  const lines = [
    `${statusGlyph(worker.status)} ${style(BOLD, title)} ${style(DIM, worker.id)}`,
    `${style(DIM, "status")} ${safeLine(worker.status, 80)}  ${style(DIM, "generation")} ${worker.generation}`,
    `${style(DIM, "executor")} ${safeLine(executor, 300)}`,
  ];
  if (worker.activeTurnId) lines.push(`${style(DIM, "turn")} ${safeLine(worker.activeTurnId, 180)}`);
  if (worker.worktree) {
    lines.push(`${style(DIM, "worktree")} ${safeLine(worker.worktree.branch, 240)}`);
    lines.push(...wrapPrefixed("  ", worker.worktree.path, width, 300));
  }
  return lines;
}

function usageFooter(worker: MonitorWorkerSnapshot, width: number): string {
  const telemetry = telemetryFor(worker);
  const left = formatUsageFooter({
    ...(telemetry.usage ?? zeroUsage()),
    latest: telemetry.latestUsage,
    contextTokens: telemetry.contextTokens,
    contextWindow: telemetry.contextWindow,
    contextKnown: telemetry.contextKnown,
    subscription: telemetry.subscription,
    automaticCompaction: telemetry.automaticCompaction,
  });
  const executor = safeLine(telemetry.latestExecutor || worker.executor, 180);
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(executor);
  if (leftWidth + rightWidth + 2 <= width) return `${left}${" ".repeat(width - leftWidth - rightWidth)}${executor}`;
  return padLine(left, width);
}

function rootTotals(snapshot: MonitorSnapshot): { steering: number; queue: number } {
  return snapshot.workers.reduce((total, worker) => {
    const coordination = coordinationFor(worker);
    return {
      steering: total.steering + (Number.isFinite(worker.steeringUpdates) ? Math.max(0, worker.steeringUpdates) : coordination.steering.length),
      queue: total.queue + (Number.isFinite(worker.queuedFollowups) ? Math.max(0, worker.queuedFollowups) : coordination.queue.length),
    };
  }, { steering: 0, queue: 0 });
}

/** Pure renderer used by the sidecar and deterministic self-tests. */
export function renderMonitorScreen(
  snapshot: MonitorSnapshot,
  width: number,
  height: number,
  state: MonitorViewState,
  now = Date.now(),
): RenderedMonitor {
  const terminalWidth = Math.max(1, width);
  const terminalHeight = Math.max(1, height);
  const selected = selectedWorker(snapshot, state.selectedWorkerId);
  const age = formatDuration(Math.max(0, now - snapshot.updatedAt));
  const connection = snapshot.connected ? style(GREEN, "connected") : style(RED, snapshot.closed ? "closed" : "disconnected");
  const totals = rootTotals(snapshot);
  const header = [
    `${style(CYAN + BOLD, "Fusion Monitor")}  ${connection}  ${style(DIM, `updated ${age} ago`)}`,
    `${style(DIM, "workers")} ${snapshot.workers.length}  ${style(BOLD, `Steering ${totals.steering} · Queue ${totals.queue}`)}`,
    `${style(DIM, "session")} ${safeLine(snapshot.sessionId, 160)}  ${style(DIM, "cwd")} ${safeLine(snapshot.cwd, 500)}`,
    `${style(DIM, "j/k or tab: worker  ↑/↓: transcript  f: follow  r: refresh  q: close")}`,
    horizontal(terminalWidth),
  ];

  if (!selected) {
    const footer = style(DIM, "No selected worker.");
    const bodyHeight = Math.max(0, terminalHeight - header.length - 1);
    const body = Array.from({ length: bodyHeight }, (_, index) => index === 0 ? style(DIM, "No Fusion workers in this session.") : "");
    const lines = [...header, ...body, footer].slice(0, terminalHeight);
    while (lines.length < terminalHeight) lines.push("");
    return { lines: lines.map((line) => padLine(line, terminalWidth)), scroll: 0, maxScroll: 0 };
  }

  const bodyHeight = Math.max(0, terminalHeight - header.length - 1); // footer is fixed
  const wide = terminalWidth >= 76;
  const selectedIndex = snapshot.workers.findIndex((worker) => worker.id === selected.id);
  const body: string[] = [];
  let maxScroll = 0;
  let scroll = 0;

  if (wide) {
    const leftWidth = clamp(Math.floor(terminalWidth * 0.27), 20, 36);
    const rightWidth = Math.max(4, terminalWidth - leftWidth - 1);
    const selectedSummary = selectedSummaryLines(selected, rightWidth);
    const fixed = [
      ...selectedSummary.slice(0, 1),
      ...coordinationLines(selected, rightWidth, now),
      ...selectedSummary.slice(1),
      "",
      style(BOLD, "Transcript"),
      horizontal(rightWidth),
    ];
    const transcript = transcriptLines(selected, rightWidth, now);
    const transcriptHeight = Math.max(0, bodyHeight - fixed.length);
    maxScroll = Math.max(0, transcript.length - transcriptHeight);
    scroll = state.follow ? maxScroll : clamp(state.scroll, 0, maxScroll);
    const transcriptSlice = transcriptHeight > 0 ? transcript.slice(scroll, scroll + transcriptHeight) : [];
    const rightLines = [...fixed.slice(0, Math.max(0, bodyHeight - Math.min(1, transcriptHeight))), ...transcriptSlice];
    const list = workerListWindow(snapshot.workers, selectedIndex, bodyHeight);
    for (let row = 0; row < bodyHeight; row++) {
      const worker = list[row];
      const workerCoordination = worker ? coordinationFor(worker) : undefined;
      const badge = workerCoordination ? style(DIM, ` S${worker?.steeringUpdates ?? workerCoordination.steering.length} Q${worker?.queuedFollowups ?? workerCoordination.queue.length}`) : "";
      const leftRaw = worker
        ? `${worker.id === selected.id ? style(CYAN, "›") : " "}${statusGlyph(worker.status)}${badge} ${safeLine(worker.label || worker.id.slice(4, 12), 100)}`
        : "";
      body.push(`${padLine(leftRaw, leftWidth)}${style(DIM, "│")}${padLine(` ${rightLines[row] ?? ""}`, rightWidth)}`);
    }
  } else {
    // Reserve the three coordination rows before secondary metadata or the
    // transcript. In very short layouts the selected worker's badge supplies
    // identity, so the "Workers" heading is dropped before coordination.
    const coordination = coordinationLines(selected, terminalWidth, now);
    const coordinationRows = Math.min(3, bodyHeight);
    const desiredWorkerRows = Math.min(4, Math.max(2, snapshot.workers.length + 1));
    const workerBudget = Math.min(desiredWorkerRows, Math.max(0, bodyHeight - coordinationRows));
    const workerRow = (worker: MonitorWorkerSnapshot): string => {
      const marker = worker.id === selected.id ? style(CYAN, "›") : " ";
      const badge = style(DIM, ` S${worker.steeringUpdates} Q${worker.queuedFollowups}`);
      return `${marker}${statusGlyph(worker.status)}${badge} ${safeLine(worker.label || worker.id.slice(4, 12), Math.max(4, terminalWidth - 12))}`;
    };
    if (workerBudget === 1) {
      body.push(workerRow(selected));
    } else if (workerBudget > 1) {
      const compact = workerListWindow(snapshot.workers, selectedIndex, workerBudget - 1);
      body.push(style(BOLD, "Workers"));
      for (const worker of compact) body.push(workerRow(worker));
      while (body.length < workerBudget) body.push("");
    }
    const remaining = Math.max(0, bodyHeight - body.length);
    const selectedSummary = selectedSummaryLines(selected, terminalWidth);
    const fixed = [...coordination, ...selectedSummary.slice(1), "", style(BOLD, "Transcript")];
    const transcript = transcriptLines(selected, terminalWidth, now);
    const fixedLines = fixed.slice(0, remaining);
    const transcriptHeight = Math.max(0, remaining - fixedLines.length);
    maxScroll = Math.max(0, transcript.length - transcriptHeight);
    scroll = state.follow ? maxScroll : clamp(state.scroll, 0, maxScroll);
    body.push(...fixedLines);
    body.push(...(transcriptHeight > 0 ? transcript.slice(scroll, scroll + transcriptHeight) : []));
  }

  while (body.length < bodyHeight) body.push("");
  const footer = usageFooter(selected, terminalWidth);
  const lines = [...header, ...body.slice(0, bodyHeight), footer].slice(0, terminalHeight);
  while (lines.length < terminalHeight) lines.push("");
  return {
    lines: lines.map((line) => padLine(line, terminalWidth)),
    selectedWorkerId: selected.id,
    scroll,
    maxScroll,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeLive(value: unknown): LiveActivity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const live = value as Record<string, unknown>;
  if ((live.phase !== "waiting" && live.phase !== "thinking" && live.phase !== "responding" && live.phase !== "tool")
    || !isFiniteNumber(live.startedAt) || typeof live.text !== "string" || !Array.isArray(live.tools)) return undefined;
  const tools = live.tools.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const tool = raw as Record<string, unknown>;
    if (typeof tool.id !== "string" || typeof tool.name !== "string" || typeof tool.arguments !== "string" || typeof tool.output !== "string") return [];
    const status: "running" | "success" | "error" | undefined = tool.status === "success" || tool.status === "error" ? tool.status : tool.status === "running" ? "running" : undefined;
    if (!status) return [];
    return [{
      id: sanitizeMonitorText(tool.id, 200),
      name: sanitizeMonitorText(tool.name, 200),
      arguments: sanitizeMonitorText(tool.arguments, TOOL_ARGUMENTS_MAX),
      output: sanitizeMonitorText(tool.output, TOOL_OUTPUT_MAX),
      status,
    }];
  });
  return {
    phase: live.phase,
    startedAt: live.startedAt,
    text: sanitizeMonitorText(live.text, 4_000),
    tools: tools.slice(-8),
  };
}

function normalizeTelemetry(value: unknown): MonitorWorkerTelemetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const usageValue = (candidate: unknown): UsageSummary | undefined => {
    if (!candidate || typeof candidate !== "object") return undefined;
    const usage = candidate as Record<string, unknown>;
    const cost = usage.cost;
    const costValue = typeof cost === "number" ? cost : cost && typeof cost === "object" && isFiniteNumber((cost as Record<string, unknown>).total) ? (cost as Record<string, unknown>).total : 0;
    return {
      input: isFiniteNumber(usage.input) ? Math.max(0, usage.input) : 0,
      output: isFiniteNumber(usage.output) ? Math.max(0, usage.output) : 0,
      cacheRead: isFiniteNumber(usage.cacheRead) ? Math.max(0, usage.cacheRead) : 0,
      cacheWrite: isFiniteNumber(usage.cacheWrite) ? Math.max(0, usage.cacheWrite) : 0,
      totalTokens: isFiniteNumber(usage.totalTokens) ? Math.max(0, usage.totalTokens) : 0,
      cost: Math.max(0, isFiniteNumber(costValue) ? costValue : 0),
    };
  };
  return {
    usage: usageValue(input.usage),
    latestUsage: usageValue(input.latestUsage),
    latestExecutor: typeof input.latestExecutor === "string" ? sanitizeMonitorText(input.latestExecutor, 300) : undefined,
    contextTokens: isFiniteNumber(input.contextTokens) ? Math.max(0, input.contextTokens) : undefined,
    contextWindow: isFiniteNumber(input.contextWindow) ? Math.max(0, input.contextWindow) : undefined,
    contextKnown: input.contextKnown === true,
    subscription: input.subscription === true,
    automaticCompaction: input.automaticCompaction !== false,
  };
}

export function parseMonitorSnapshot(raw: string): MonitorSnapshot | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Record<string, unknown>;
    if ((value.schemaVersion !== 1 && value.schemaVersion !== 2)
      || !Array.isArray(value.workers)
      || typeof value.sessionId !== "string"
      || typeof value.cwd !== "string"
      || !isFiniteNumber(value.updatedAt)
      || typeof value.connected !== "boolean"
      || !isFiniteNumber(value.ownerPid)) return undefined;
    const workers: MonitorWorkerSnapshot[] = [];
    for (const rawWorker of value.workers) {
      if (!rawWorker || typeof rawWorker !== "object") return undefined;
      const worker = rawWorker as Record<string, unknown>;
      const history = normalizedHistory(worker.history);
      if (typeof worker.id !== "string" || typeof worker.status !== "string" || !isFiniteNumber(worker.generation)
        || typeof worker.executor !== "string" || !isFiniteNumber(worker.createdAt) || !history) return undefined;
      const coordinationValue = worker.coordination;
      let coordination: MonitorCoordinationSnapshot | undefined;
      if (coordinationValue !== undefined) {
        if (!coordinationValue || typeof coordinationValue !== "object") return undefined;
        const rawCoord = coordinationValue as Record<string, unknown>;
        const steering = Array.isArray(rawCoord.steering) ? rawCoord.steering.slice(-12).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.id !== "string" || typeof entry.preview !== "string") return [];
          return [{ id: sanitizeMonitorText(entry.id, 120), turnId: typeof entry.turnId === "string" ? sanitizeMonitorText(entry.turnId, 120) : "", status: entry.status === "injected" ? "injected" as const : "pending" as const, preview: sanitizeMonitorText(entry.preview, PREVIEW_MAX), enqueuedAt: isFiniteNumber(entry.enqueuedAt) ? entry.enqueuedAt : 0 }];
        }) : [];
        const queue = Array.isArray(rawCoord.queue) ? rawCoord.queue.slice(0, 12).flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.id !== "string" || typeof entry.preview !== "string") return [];
          return [{ id: sanitizeMonitorText(entry.id, 120), status: "queued" as const, strategy: entry.strategy === "interrupt" ? "interrupt" as const : "queue" as const, preview: sanitizeMonitorText(entry.preview, PREVIEW_MAX), enqueuedAt: isFiniteNumber(entry.enqueuedAt) ? entry.enqueuedAt : 0, ...(typeof entry.interruptedTurnId === "string" ? { interruptedTurnId: sanitizeMonitorText(entry.interruptedTurnId, 120) } : {}) }];
        }) : [];
        coordination = { steering, queue };
      }
      const live = worker.live === undefined ? undefined : normalizeLive(worker.live);
      if (worker.live !== undefined && !live) return undefined;
      workers.push({
        id: sanitizeMonitorText(worker.id, 200),
        ...(typeof worker.label === "string" ? { label: sanitizeMonitorText(worker.label, 200) } : {}),
        status: sanitizeMonitorText(worker.status, 80),
        generation: worker.generation,
        executor: sanitizeMonitorText(worker.executor, 300),
        ...(typeof worker.activeTurnId === "string" ? { activeTurnId: sanitizeMonitorText(worker.activeTurnId, 200) } : {}),
        createdAt: worker.createdAt,
        ...(worker.worktree && typeof worker.worktree === "object" && typeof (worker.worktree as Record<string, unknown>).branch === "string" && typeof (worker.worktree as Record<string, unknown>).path === "string"
          ? { worktree: { branch: sanitizeMonitorText((worker.worktree as Record<string, unknown>).branch, 300), path: sanitizeMonitorText((worker.worktree as Record<string, unknown>).path, 500) } }
          : {}),
        queuedFollowups: isFiniteNumber(worker.queuedFollowups) ? Math.max(0, worker.queuedFollowups) : coordination?.queue.length ?? 0,
        steeringUpdates: isFiniteNumber(worker.steeringUpdates) ? Math.max(0, worker.steeringUpdates) : coordination?.steering.length ?? 0,
        ...(coordination ? { coordination } : {}),
        history,
        ...(worker.telemetry ? { telemetry: normalizeTelemetry(worker.telemetry) } : {}),
        ...(live ? { live } : {}),
      });
    }
    return {
      schemaVersion: value.schemaVersion,
      sessionId: sanitizeMonitorText(value.sessionId, 200),
      cwd: sanitizeMonitorText(value.cwd, 500),
      ...(typeof value.themeName === "string" ? { themeName: sanitizeMonitorText(value.themeName, 160) } : {}),
      ...(typeof value.selectedWorkerId === "string" ? { selectedWorkerId: sanitizeMonitorText(value.selectedWorkerId, 200) } : {}),
      workers,
      updatedAt: value.updatedAt,
      connected: value.connected,
      ...(typeof value.closed === "boolean" ? { closed: value.closed } : {}),
      ...(typeof value.closeReason === "string" ? { closeReason: sanitizeMonitorText(value.closeReason, 500) } : {}),
      ownerPid: value.ownerPid,
    };
  } catch {
    return undefined;
  }
}

export function isMonitorOwnerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function shouldTerminateMonitor(
  snapshot: MonitorSnapshot,
  now = Date.now(),
  staleAfterMs = MONITOR_STALE_AFTER_MS,
  heartbeatAt = snapshot.updatedAt,
): boolean {
  if (snapshot.closed) return true;
  if (!isMonitorOwnerAlive(snapshot.ownerPid)) return true;
  return now - Math.max(snapshot.updatedAt, heartbeatAt) > staleAfterMs;
}

export function monitorSnapshotPath(sessionId: string, root = join(tmpdir(), "pi-fusion-monitor")): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "session";
  return join(root, `${safeSession}.json`);
}

/** Atomic, owner-only snapshot publisher. It never exposes private thinking. */
export class FusionMonitorPublisher {
  readonly #getPayload: () => MonitorSnapshotPayload;
  #active = false;
  #snapshotPath?: string;
  #refreshTimer?: ReturnType<typeof setTimeout>;
  #heartbeatTimer?: ReturnType<typeof setInterval>;
  #writeQueue: Promise<void> = Promise.resolve();
  #lifecycleGeneration = 0;
  #lastPayload?: MonitorSnapshotPayload;
  #lastError?: string;

  constructor(getPayload: () => MonitorSnapshotPayload) {
    this.#getPayload = getPayload;
  }

  get active(): boolean {
    return this.#active;
  }

  get path(): string | undefined {
    return this.#snapshotPath;
  }

  get lastError(): string | undefined {
    return this.#lastError;
  }

  async open(sessionId: string, root?: string): Promise<string> {
    // A new session must never inherit the previous session's cached payload.
    // Capture fresh data before mutating the active path/lifecycle state.
    const payload = this.#capturePayload(false);
    if (!payload) throw new Error(this.#lastError ?? "Could not build Fusion monitor snapshot.");
    const lifecycleGeneration = ++this.#lifecycleGeneration;
    const snapshotPath = monitorSnapshotPath(sessionId, root);
    this.#snapshotPath = snapshotPath;
    this.#active = true;
    this.#startHeartbeat();
    try {
      await this.#enqueueWrite(snapshotPath, {
        ...payload,
        updatedAt: Date.now(),
        connected: true,
        ownerPid: process.pid,
      });
      this.#lastError = undefined;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      if (this.#lifecycleGeneration === lifecycleGeneration && this.#snapshotPath === snapshotPath) {
        this.#active = false;
        this.#stopTimers();
      }
      throw error;
    }
    return snapshotPath;
  }

  refresh(): void {
    if (!this.#active || this.#refreshTimer) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      if (!this.#active || !this.#snapshotPath) return;
      const payload = this.#capturePayload();
      if (!payload) return;
      const operation = this.#enqueueWrite(this.#snapshotPath, {
        ...payload,
        updatedAt: Date.now(),
        connected: true,
        ownerPid: process.pid,
      });
      void operation.then(
        () => { this.#lastError = undefined; },
        (error) => { this.#lastError = error instanceof Error ? error.message : String(error); },
      );
    }, SNAPSHOT_WRITE_DELAY_MS);
  }

  async close(reason = "closed by Lead"): Promise<void> {
    this.#lifecycleGeneration += 1;
    const snapshotPath = this.#snapshotPath;
    if (!snapshotPath) return;
    this.#active = false;
    this.#stopTimers();
    const payload = this.#capturePayload();
    if (!payload) return;
    try {
      await this.#enqueueWrite(snapshotPath, {
        ...payload,
        updatedAt: Date.now(),
        connected: false,
        closed: true,
        closeReason: reason,
        ownerPid: process.pid,
      });
      this.#lastError = undefined;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  #capturePayload(allowLastPayload = true): MonitorSnapshotPayload | undefined {
    try {
      const payload = this.#getPayload();
      this.#lastPayload = payload;
      return payload;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      return allowLastPayload ? this.#lastPayload : undefined;
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeatTimer) return;
    this.#heartbeatTimer = setInterval(() => {
      const snapshotPath = this.#snapshotPath;
      if (!this.#active || !snapshotPath) return;
      const now = new Date();
      void utimes(snapshotPath, now, now).catch(() => undefined);
    }, MONITOR_HEARTBEAT_MS);
    this.#heartbeatTimer.unref?.();
  }

  #stopTimers(): void {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#refreshTimer = undefined;
    this.#heartbeatTimer = undefined;
  }

  #enqueueWrite(snapshotPath: string, snapshot: MonitorSnapshot): Promise<void> {
    const operation = this.#writeQueue.then(() => this.#write(snapshotPath, snapshot));
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async #write(snapshotPath: string, snapshot: MonitorSnapshot): Promise<void> {
    const directory = dirname(snapshotPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporary = `${snapshotPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, snapshotPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function manualMonitorCommand(scriptPath: string, snapshotPath: string): string {
  return [process.execPath, "--no-warnings", scriptPath, snapshotPath].map(shellQuote).join(" ");
}

export function buildMonitorLaunchPlan(
  scriptPath: string,
  snapshotPath: string,
  options: { platform?: NodeJS.Platform; ghostty?: boolean; terminal?: boolean } = {},
): MonitorLaunchPlan | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return undefined;
  const hasGhostty = options.ghostty ?? existsSync("/Applications/Ghostty.app");
  if (hasGhostty) {
    return {
      kind: "ghostty",
      command: "/usr/bin/open",
      args: [
        "-na",
        "Ghostty.app",
        "--args",
        "--title=Fusion Monitor",
        "-e",
        process.execPath,
        "--no-warnings",
        scriptPath,
        snapshotPath,
      ],
    };
  }
  const hasTerminal = options.terminal ?? existsSync("/System/Applications/Utilities/Terminal.app");
  if (!hasTerminal) return undefined;
  const command = manualMonitorCommand(scriptPath, snapshotPath);
  const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return {
    kind: "terminal",
    command: "/usr/bin/osascript",
    args: [
      "-e",
      `tell application "Terminal" to do script "${escaped}"`,
      "-e",
      "tell application \"Terminal\" to activate",
    ],
  };
}

export async function launchMonitorWindow(scriptPath: string, snapshotPath: string): Promise<MonitorLaunchPlan> {
  const plan = buildMonitorLaunchPlan(scriptPath, snapshotPath);
  if (!plan) throw new Error(`No supported terminal launcher. Run manually: ${manualMonitorCommand(scriptPath, snapshotPath)}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { detached: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${plan.kind} launcher exited with code ${code ?? "unknown"}`));
    });
  });
  return plan;
}
