import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { LiveActivity, PaneHistoryItem } from "./pane.ts";

export interface MonitorWorkerSnapshot {
  id: string;
  label?: string;
  status: string;
  generation: number;
  executor: string;
  activeTurnId?: string;
  createdAt: number;
  worktree?: { branch: string; path: string };
  queuedFollowups: number;
  steeringUpdates: number;
  history: PaneHistoryItem[];
  live?: LiveActivity;
}

export interface MonitorSnapshotPayload {
  schemaVersion: 1;
  sessionId: string;
  cwd: string;
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
const HISTORY_TEXT_MAX = 8_000;

function style(code: string, text: string): string {
  return `${code}${text}${RESET}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Strip terminal controls before rendering data originating in tools/models. */
export function sanitizeMonitorText(value: unknown, max = HISTORY_TEXT_MAX): string {
  const text = stripTerminalSequences(typeof value === "string" ? value : String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r/g, "");
  return text.length > max ? `...${text.slice(-(max - 3))}` : text;
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

function roleLabel(role: PaneHistoryItem["role"]): string {
  if (role === "LEAD") return style(BLUE, "LEAD");
  if (role === "SIDEKICK") return style(MAGENTA, "SIDEKICK");
  return style(YELLOW, "TOOL");
}

function wrapPrefixed(prefix: string, text: string, width: number): string[] {
  const safe = sanitizeMonitorText(text);
  const prefixWidth = visibleWidth(prefix);
  const bodyWidth = Math.max(8, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(safe || "(empty)", bodyWidth);
  return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
}

function detailLines(worker: MonitorWorkerSnapshot, width: number, now: number): string[] {
  const lines: string[] = [];
  const title = safeLine(worker.label || "sidekick", 200);
  lines.push(
    `${statusGlyph(worker.status)} ${style(BOLD, title)} ${style(DIM, worker.id)}`,
    `${style(DIM, "status")} ${safeLine(worker.status, 80)}  ${style(DIM, "generation")} ${worker.generation}`,
    `${style(DIM, "executor")} ${safeLine(worker.executor, 300)}`,
  );
  if (worker.activeTurnId) lines.push(`${style(DIM, "turn")} ${safeLine(worker.activeTurnId, 200)}`);
  if (worker.worktree) {
    lines.push(`${style(DIM, "worktree")} ${safeLine(worker.worktree.branch, 300)}`);
    lines.push(...wrapPrefixed("  ", worker.worktree.path, width));
  }
  if (worker.queuedFollowups > 0 || worker.steeringUpdates > 0) {
    lines.push(`${style(YELLOW, `queued ${worker.queuedFollowups}`)}  ${style(CYAN, `steer ${worker.steeringUpdates}`)}`);
  }

  lines.push("", style(BOLD, "Conversation"), horizontal(width));
  if (worker.history.length === 0) lines.push(style(DIM, "No visible history."));
  for (const item of worker.history) {
    lines.push(...wrapPrefixed(`${roleLabel(item.role)}  `, item.text, width));
    lines.push("");
  }

  lines.push(style(BOLD, "Live"), horizontal(width));
  if (!worker.live) {
    lines.push(style(DIM, worker.status === "running" ? "Waiting for live telemetry..." : "No active turn."));
    return lines;
  }

  lines.push(`${style(CYAN, worker.live.phase)}  ${style(DIM, formatDuration(now - worker.live.startedAt))}`);
  if (worker.live.text) {
    lines.push(...wrapPrefixed(`${style(MAGENTA, "SIDEKICK")}  `, worker.live.text, width));
  }
  for (const tool of worker.live.tools) {
    const name = safeLine(tool.name, 200);
    lines.push("", `${toolGlyph(tool.status)} ${style(BOLD, name)} ${style(DIM, tool.status)}`);
    if (tool.arguments) lines.push(...wrapPrefixed(`${style(DIM, "args")}  `, tool.arguments, width));
    if (tool.output) lines.push(...wrapPrefixed(`${style(DIM, "out ")}  `, tool.output, width));
  }
  return lines;
}

function selectedWorker(snapshot: MonitorSnapshot, requestedId: string | undefined): MonitorWorkerSnapshot | undefined {
  return snapshot.workers.find((worker) => worker.id === requestedId)
    ?? [...snapshot.workers].reverse().find((worker) => worker.status === "running")
    ?? snapshot.workers.at(-1);
}

function workerListWindow(workers: MonitorWorkerSnapshot[], selectedIndex: number, height: number): MonitorWorkerSnapshot[] {
  if (workers.length <= height) return workers;
  const start = clamp(selectedIndex - Math.floor(height / 2), 0, workers.length - height);
  return workers.slice(start, start + height);
}

/** Pure renderer used by the sidecar and self-tests. */
export function renderMonitorScreen(
  snapshot: MonitorSnapshot,
  width: number,
  height: number,
  state: MonitorViewState,
  now = Date.now(),
): RenderedMonitor {
  const terminalWidth = Math.max(24, width);
  const terminalHeight = Math.max(8, height);
  const selected = selectedWorker(snapshot, state.selectedWorkerId);
  const age = formatDuration(Math.max(0, now - snapshot.updatedAt));
  const connection = snapshot.connected ? style(GREEN, "connected") : style(RED, snapshot.closed ? "closed" : "disconnected");
  const header = [
    `${style(CYAN + BOLD, "Fusion Monitor")}  ${connection}  ${style(DIM, `updated ${age} ago`)}  workers ${snapshot.workers.length}`,
    `${style(DIM, "session")} ${safeLine(snapshot.sessionId, 160)}  ${style(DIM, "cwd")} ${safeLine(snapshot.cwd, 500)}`,
    `${style(DIM, "j/k or tab: worker  ↑/↓: scroll  f: follow  r: refresh  q: close")}`,
    horizontal(terminalWidth),
  ];
  const bodyHeight = terminalHeight - header.length;

  if (!selected) {
    const body = ["", style(DIM, "No Fusion workers in this session."), ""];
    const lines = [...header, ...body];
    while (lines.length < terminalHeight) lines.push("");
    return { lines: lines.slice(0, terminalHeight).map((line) => padLine(line, terminalWidth)), scroll: 0, maxScroll: 0 };
  }

  const wide = terminalWidth >= 76;
  const leftWidth = wide ? clamp(Math.floor(terminalWidth * 0.27), 24, 36) : terminalWidth;
  const rightWidth = wide ? terminalWidth - leftWidth - 1 : terminalWidth;
  const details = detailLines(selected, Math.max(12, rightWidth - (wide ? 1 : 0)), now);
  const narrowWorkerRows = wide ? 0 : Math.min(4, Math.max(2, snapshot.workers.length + 1));
  const detailHeight = Math.max(1, bodyHeight - narrowWorkerRows);
  const maxScroll = Math.max(0, details.length - detailHeight);
  const scroll = state.follow ? maxScroll : clamp(state.scroll, 0, maxScroll);
  const detailSlice = details.slice(scroll, scroll + detailHeight);
  while (detailSlice.length < detailHeight) detailSlice.push("");

  const selectedIndex = snapshot.workers.findIndex((worker) => worker.id === selected.id);
  const body: string[] = [];
  if (wide) {
    const list = workerListWindow(snapshot.workers, selectedIndex, bodyHeight);
    for (let row = 0; row < bodyHeight; row++) {
      const worker = list[row];
      const leftRaw = worker
        ? `${worker.id === selected.id ? style(CYAN, "›") : " "}${statusGlyph(worker.status)} ${safeLine(worker.label || worker.id.slice(4, 12), 120)} ${style(DIM, `g${worker.generation}`)}`
        : "";
      const left = padLine(leftRaw, leftWidth);
      const right = padLine(` ${detailSlice[row] ?? ""}`, rightWidth);
      body.push(`${left}${style(DIM, "│")}${right}`);
    }
  } else {
    body.push(style(BOLD, "Workers"));
    const compact = workerListWindow(snapshot.workers, selectedIndex, narrowWorkerRows - 1);
    for (const worker of compact) {
      const marker = worker.id === selected.id ? style(CYAN, "›") : " ";
      body.push(`${marker}${statusGlyph(worker.status)} ${safeLine(worker.label || worker.id.slice(4, 12), terminalWidth - 8)}`);
    }
    while (body.length < narrowWorkerRows) body.push("");
    body.push(...detailSlice);
  }

  const lines = [...header, ...body];
  while (lines.length < terminalHeight) lines.push("");
  return {
    lines: lines.slice(0, terminalHeight).map((line) => padLine(line, terminalWidth)),
    selectedWorkerId: selected.id,
    scroll,
    maxScroll,
  };
}

export function parseMonitorSnapshot(raw: string): MonitorSnapshot | undefined {
  try {
    const value = JSON.parse(raw) as Partial<MonitorSnapshot>;
    if (
      value.schemaVersion !== 1
      || !Array.isArray(value.workers)
      || typeof value.sessionId !== "string"
      || typeof value.cwd !== "string"
      || typeof value.updatedAt !== "number"
      || typeof value.connected !== "boolean"
      || typeof value.ownerPid !== "number"
    ) return undefined;
    for (const worker of value.workers) {
      if (
        !worker
        || typeof worker.id !== "string"
        || typeof worker.status !== "string"
        || typeof worker.generation !== "number"
        || typeof worker.executor !== "string"
        || !Array.isArray(worker.history)
        || (worker.live !== undefined && !Array.isArray(worker.live.tools))
      ) return undefined;
    }
    return value as MonitorSnapshot;
  } catch {
    return undefined;
  }
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
  #timer?: ReturnType<typeof setTimeout>;
  #inflight?: Promise<void>;
  #dirty = false;
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
    this.#snapshotPath = monitorSnapshotPath(sessionId, root);
    this.#active = true;
    this.#dirty = true;
    await this.#flushNow();
    if (this.#lastError) {
      this.#active = false;
      throw new Error(this.#lastError);
    }
    return this.#snapshotPath;
  }

  refresh(): void {
    if (!this.#active) return;
    this.#dirty = true;
    if (this.#timer || this.#inflight) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flushNow();
    }, SNAPSHOT_WRITE_DELAY_MS);
  }

  async close(reason = "closed by Lead"): Promise<void> {
    if (!this.#snapshotPath) return;
    this.#active = false;
    this.#dirty = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#inflight) await this.#inflight.catch(() => undefined);
    let payload = this.#lastPayload;
    try {
      payload = this.#getPayload();
      this.#lastPayload = payload;
    } catch {
      // Preserve the last valid public snapshot during teardown.
    }
    if (!payload) return;
    await this.#write({ ...payload, updatedAt: Date.now(), connected: false, closed: true, closeReason: reason, ownerPid: process.pid });
  }

  async #flushNow(): Promise<void> {
    if (!this.#active || !this.#snapshotPath) return;
    if (this.#inflight) {
      this.#dirty = true;
      await this.#inflight.catch(() => undefined);
      return;
    }
    this.#dirty = false;
    let payload: MonitorSnapshotPayload;
    try {
      payload = this.#getPayload();
      this.#lastPayload = payload;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    this.#inflight = this.#write({ ...payload, updatedAt: Date.now(), connected: true, ownerPid: process.pid });
    try {
      await this.#inflight;
      this.#lastError = undefined;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.#inflight = undefined;
      if (this.#active && this.#dirty) this.refresh();
    }
  }

  async #write(snapshot: MonitorSnapshot): Promise<void> {
    const snapshotPath = this.#snapshotPath;
    if (!snapshotPath) return;
    const directory = dirname(snapshotPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporary = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, snapshotPath);
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
